import type { Plugin } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import type { StartedPeer, StartPeerOptions } from './peer.js';
import {
  clearPrivateSessionContext,
  clearSessionWorkContext,
  hydrateContextPack,
  resolveSafeBaseUrl,
  type ContextPackHydrationResult,
  type PrivateSessionContextClearance,
  type SessionContextClearance,
} from './contextPackHydration.js';
import { capturePluginException } from './sentry.js';
import {
  clearRuntimeSessionHydration,
  readRuntimeSessionHydration,
} from './runtimeSessionContext.js';
import {
  bridgeOpenCodeQuestions,
  parseQuestionRequest,
} from './attentionBridge.js';
import { captureGatewayCredential } from './childProcessEnv.js';
import { bridgeOpenCodeSessionSummary } from './sessionSummaryBridge.js';
import { normalizeAbsoluteHostPath } from './hostPath.js';
import {
  appendAdditionalContext,
  contextHydrationKey,
  finalizeSessionContext,
  isRunEndConsumptionPersisted,
  isSuccessfulAssistantCompletion,
  nativeSessionId,
  sessionStartAdditionalContext,
} from './pluginSessionLifecycle.js';

type StartPeer = (opts: StartPeerOptions) => Promise<StartedPeer>;
type Env = Record<string, string | undefined>;
type Logger = Pick<Console, 'log' | 'warn' | 'error'>;
type BridgeSessionSummary = typeof bridgeOpenCodeSessionSummary;
type HydrateContextPack = (input: {
  disabled?: boolean;
  env?: Env;
  projectDir?: string;
  sessionId?: string;
}) => Promise<ContextPackHydrationResult>;
type ClearSessionWorkContext = (input: {
  env?: Env;
  projectDir?: string;
  sessionId?: string;
}) => Promise<SessionContextClearance>;
type ClearPrivateSessionContext = (input: {
  env?: Env;
  projectDir?: string;
  sessionId?: string;
}) => Promise<PrivateSessionContextClearance>;

export type CreateOrgXOpenCodePluginOptions = {
  startPeer?: StartPeer;
  env?: Env;
  logger?: Logger;
  bridgeSessionSummary?: BridgeSessionSummary;
  hydrateContextPack?: HydrateContextPack;
  clearSessionWorkContext?: ClearSessionWorkContext;
  clearPrivateSessionContext?: ClearPrivateSessionContext;
};

export function createOrgXOpenCodePlugin(
  opts: CreateOrgXOpenCodePluginOptions = {}
): Plugin {
  const start = opts.startPeer ?? defaultStartPeer;
  const env = opts.env ?? process.env;
  const apiKey = captureGatewayCredential(env);
  const rawBaseUrl = env.ORGX_BASE_URL;
  const safeBaseUrl = resolveSafeBaseUrl(rawBaseUrl);
  const invalidBaseUrl = Boolean(rawBaseUrl?.trim()) && !safeBaseUrl;
  if (invalidBaseUrl) delete env.ORGX_BASE_URL;
  const logger = opts.logger ?? console;
  const bridgeSessionSummary =
    opts.bridgeSessionSummary ?? bridgeOpenCodeSessionSummary;
  const hydrate = opts.hydrateContextPack ?? hydrateContextPack;
  const clearContext =
    opts.clearSessionWorkContext ?? clearSessionWorkContext;
  const clearPrivateContext =
    opts.clearPrivateSessionContext ?? clearPrivateSessionContext;
  let peer: Promise<StartedPeer> | null = null;
  const contextHydrations = new Map<
    string,
    Promise<ContextPackHydrationResult>
  >();
  const sessionStarts = new Map<
    string,
    Promise<ContextPackHydrationResult>
  >();
  const sessionsWithModelWork = new Set<string>();
  const sessionsWithRunEnd = new Set<string>();
  const gatewayScopedSessions = new Set<string>();
  let warnedMissingConfig = false;
  let warnedMissingAttentionConfig = false;
  const activeAttention = new Set<string>();

  async function startIfConfigured(
    openCodeServerUrl: string,
    openCodeDirectory: string
  ) {
    if (peer) return;

    const workspaceId = env.ORGX_WORKSPACE_ID;
    const baseUrl = safeBaseUrl ?? undefined;

    if (!apiKey || !workspaceId || invalidBaseUrl) {
      if (!warnedMissingConfig) {
        logger.warn(
          invalidBaseUrl
            ? '[orgx-opencode-plugin] native plugin loaded, but ORGX_BASE_URL is not a credential-free HTTPS or loopback HTTP URL'
            : '[orgx-opencode-plugin] native plugin loaded, but ORGX_API_KEY and ORGX_WORKSPACE_ID are required to connect'
        );
        warnedMissingConfig = true;
      }
      return;
    }

    peer = start({
      apiKey,
      workspaceId,
      baseUrl,
      openCodeServerUrl,
      openCodeDirectory,
    });
    try {
      await peer;
      logger.log('[orgx-opencode-plugin] native OpenCode plugin peer started');
    } catch (err) {
      peer = null;
      capturePluginException(err, { stage: 'native_plugin_start' });
      logger.error('[orgx-opencode-plugin] failed to start peer', formatError(err));
    }
  }

  async function hydrateProjectContext(
    projectDir: string,
    sessionId: string
  ): Promise<ContextPackHydrationResult> {
    const normalizedProjectDir = normalizeAbsoluteHostPath(projectDir);
    if (!normalizedProjectDir) {
      return { ok: true, skipped: 'project_directory_unavailable' };
    }
    const runtimeHydration = readRuntimeSessionHydration(
      normalizedProjectDir,
      sessionId
    );
    const key = contextHydrationKey(normalizedProjectDir, sessionId)!;
    if (runtimeHydration) {
      gatewayScopedSessions.add(key);
      return runtimeHydration;
    }
    const existing = contextHydrations.get(key);
    if (existing) return existing;
    const hydration = hydrate({
      disabled: invalidBaseUrl,
      env: {
        ...env,
        ORGX_API_KEY: apiKey,
        ORGX_BASE_URL: safeBaseUrl ?? undefined,
      },
      projectDir: normalizedProjectDir,
      sessionId,
    }).catch((error) => {
        capturePluginException(error, { stage: 'context_pack_hydration' });
        logger.warn(
          `[orgx-opencode-plugin] context hydration unavailable: ${formatError(error)}`
        );
        return { ok: false, skipped: 'context_pack_hydration_failed' } as const;
      });
    contextHydrations.set(key, hydration);
    return hydration;
  }

  return async (input) => {
    const exactProjectDir = normalizeAbsoluteHostPath(input.directory);
    const projectDir = exactProjectDir ?? input.directory;
    const capture = async (nativeEvent: string, payload: unknown) => {
      try {
        return await bridgeSessionSummary({
          nativeEvent,
          payload,
          directory: projectDir,
          env,
        });
      } catch (error) {
        capturePluginException(error, { stage: 'session_summary_bridge' });
        logger.warn(
          `[orgx-opencode-plugin] session summary capture unavailable: ${formatError(error)}`
        );
        return undefined;
      }
    };

    const ensureSessionStart = async (
      sessionId: string,
      payload: unknown
    ): Promise<ContextPackHydrationResult> => {
      const normalizedProjectDir = normalizeAbsoluteHostPath(projectDir);
      const key = normalizedProjectDir
        ? contextHydrationKey(normalizedProjectDir, sessionId)
        : null;
      if (!normalizedProjectDir || !key) {
        return { ok: true, skipped: 'project_directory_unavailable' };
      }

      const runtimeHydration = readRuntimeSessionHydration(
        normalizedProjectDir,
        sessionId
      );
      if (runtimeHydration) {
        gatewayScopedSessions.add(key);
        let start = sessionStarts.get(key);
        if (!start) {
          start = capture('session.created', payload).then(
            () => runtimeHydration
          );
          sessionStarts.set(key, start);
        }
        await start;
        return runtimeHydration;
      }

      const existing = sessionStarts.get(key);
      if (existing) return existing;
      const start = (async () => {
        const sessionStart = await capture('session.created', payload);
        const additionalContext = sessionStartAdditionalContext(sessionStart);
        if (additionalContext) {
          const claimed = { ok: true, additionalContext } as const;
          contextHydrations.set(key, Promise.resolve(claimed));
          return claimed;
        }
        return hydrateProjectContext(normalizedProjectDir, sessionId);
      })();
      sessionStarts.set(key, start);
      return start;
    };

    return {
      'chat.message': async (messageInput, output) => {
        const sessionId = nativeSessionId(messageInput);
        if (sessionId) {
          const result = await ensureSessionStart(sessionId, {
            sessionID: sessionId,
          });
          const key = contextHydrationKey(projectDir, sessionId);
          if (!key || !sessionsWithModelWork.has(key)) {
            appendAdditionalContext(output.message, result.additionalContext);
          }
        }
        const prompt = output.parts
          .filter(
            (part): part is typeof part & { type: 'text'; text: string } =>
              part.type === 'text' &&
              typeof (part as { text?: unknown }).text === 'string' &&
              (part as { synthetic?: unknown }).synthetic !== true &&
              (part as { ignored?: unknown }).ignored !== true
          )
          .map((part) => part.text)
          .join('\n')
          .trim();
        await capture('chat.message', {
          sessionID: messageInput.sessionID,
          messageID: messageInput.messageID,
          ...(prompt ? { prompt } : {}),
        });
      },
      event: async ({ event }) => {
        const sessionId = nativeSessionId(event);
        const key = sessionId
          ? contextHydrationKey(projectDir, sessionId)
          : null;
        if (key && isSuccessfulAssistantCompletion(event)) {
          sessionsWithModelWork.add(key);
        }
        let eventAlreadyCaptured = false;
        if (event.type === 'session.created' && sessionId) {
          await ensureSessionStart(sessionId, event);
          eventAlreadyCaptured = true;
        }

        const runEndedBeforeModelWork =
          key !== null &&
          !sessionsWithModelWork.has(key) &&
          (event.type === 'session.idle' || event.type === 'session.error');
        const sessionAbandoned =
          key !== null &&
          !sessionsWithModelWork.has(key) &&
          !gatewayScopedSessions.has(key) &&
          event.type === 'session.deleted';
        const gatewaySessionFailedBeforeModelWork =
          key !== null &&
          !sessionsWithModelWork.has(key) &&
          gatewayScopedSessions.has(key) &&
          event.type === 'session.deleted';

        let usedSessionEndUnverified = false;
        if (
          key &&
          event.type === 'session.deleted' &&
          sessionsWithModelWork.has(key) &&
          !sessionsWithRunEnd.has(key)
        ) {
          const runEnd = await capture('session.idle', event);
          if (isRunEndConsumptionPersisted(runEnd)) {
            sessionsWithRunEnd.add(key);
          } else {
            usedSessionEndUnverified = true;
            logger.warn(
              '[orgx-opencode-plugin] model work consumption marker unverified; SessionEnd recovery was suppressed'
            );
          }
        }

        if (
          !eventAlreadyCaptured &&
          !runEndedBeforeModelWork &&
          !sessionAbandoned &&
          !gatewaySessionFailedBeforeModelWork &&
          !usedSessionEndUnverified
        ) {
          const result = await capture(event.type, event);
          if (
            key &&
            sessionsWithModelWork.has(key) &&
            (event.type === 'session.idle' || event.type === 'session.error') &&
            isRunEndConsumptionPersisted(result)
          ) {
            sessionsWithRunEnd.add(key);
          }
        }

        if (event.type === 'server.connected') {
          if (!exactProjectDir) {
            logger.warn(
              '[orgx-opencode-plugin] native plugin requires an absolute project directory'
            );
          } else {
            await startIfConfigured(
              input.serverUrl.toString(),
              exactProjectDir
            );
          }
        }
        if (event.type === 'session.deleted' && sessionId) {
          if (key) await contextHydrations.get(key);
          await finalizeSessionContext({
            capture,
            clearContext,
            clearPrivate: clearPrivateContext,
            env,
            event,
            logger,
            mode: gatewaySessionFailedBeforeModelWork
              ? 'gateway_abandoned'
              : sessionAbandoned
                ? 'interactive_abandoned'
                : 'used',
            onException: (error, stage) => {
              capturePluginException(error, { stage });
            },
            projectDir,
            sessionId,
          });
          if (key) {
            contextHydrations.delete(key);
            sessionStarts.delete(key);
            sessionsWithModelWork.delete(key);
            sessionsWithRunEnd.delete(key);
            gatewayScopedSessions.delete(key);
          }
          clearRuntimeSessionHydration(projectDir, sessionId);
          return;
        }

        if (env.ORGX_REMOTE_ATTENTION !== '1') return;
        const questionRequest = parseQuestionRequest(event);
        if (!questionRequest || activeAttention.has(questionRequest.id)) return;

        const initiativeId = env.ORGX_INITIATIVE_ID;
        if (!apiKey || !initiativeId || !safeBaseUrl) {
          if (!warnedMissingAttentionConfig) {
            logger.warn(
              '[orgx-opencode-plugin] remote attention requires ORGX_API_KEY and ORGX_INITIATIVE_ID'
            );
            warnedMissingAttentionConfig = true;
          }
          return;
        }

        activeAttention.add(questionRequest.id);
        const nativeClient = createOpencodeClient({
          baseUrl: input.serverUrl.toString(),
          directory: projectDir,
        });
        void bridgeOpenCodeQuestions({
          request: questionRequest,
          apiKey,
          initiativeId,
          runId: env.ORGX_RUN_ID,
          workstreamId: env.ORGX_WORKSTREAM_ID,
          baseUrl: safeBaseUrl,
          reply: async (answers) => {
            await nativeClient.question.reply({
              requestID: questionRequest.id,
              answers,
            });
          },
        })
          .then(() => {
            logger.log(
              `[orgx-opencode-plugin] resumed native question ${questionRequest.id}`
            );
          })
          .catch((error) => {
            capturePluginException(error, { stage: 'native_attention_bridge' });
            logger.error(
              '[orgx-opencode-plugin] could not resume native question',
              formatError(error)
            );
          })
          .finally(() => activeAttention.delete(questionRequest.id));
      },
      'tool.execute.before': async (toolInput, output) => {
        const sessionId = nativeSessionId(toolInput);
        if (sessionId) {
          await ensureSessionStart(sessionId, { sessionID: sessionId });
          const key = contextHydrationKey(projectDir, sessionId);
          if (key) sessionsWithModelWork.add(key);
        }
        await capture('tool.execute.before', {
          ...toolInput,
          args: output?.args,
        });
      },
      'tool.execute.after': async (toolInput) => {
        const sessionId = nativeSessionId(toolInput);
        if (sessionId) {
          await ensureSessionStart(sessionId, { sessionID: sessionId });
        }
        await capture('tool.execute.after', toolInput);
      },
    };
  };
}

async function defaultStartPeer(opts: StartPeerOptions): Promise<StartedPeer> {
  const { startPeer } = await import('./peer.js');
  return startPeer(opts);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const OrgXOpenCodePlugin = createOrgXOpenCodePlugin();
export default OrgXOpenCodePlugin;
