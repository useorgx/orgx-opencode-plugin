import type { Plugin } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import type { StartedPeer, StartPeerOptions } from './peer.js';
import {
  MAX_ADDITIONAL_CONTEXT_BYTES,
  clearSessionWorkContext,
  hydrateContextPack,
  resolveSafeBaseUrl,
  type ContextPackHydrationResult,
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nativeSessionId(value: unknown): string | undefined {
  const root = record(value);
  const properties = record(root.properties);
  const info = record(properties.info);
  for (const candidate of [
    root.sessionID,
    root.session_id,
    properties.sessionID,
    properties.session_id,
    info.sessionID,
    info.session_id,
    info.id,
  ]) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function contextHydrationKey(
  projectDir: string,
  sessionId: string
): string | null {
  const normalizedProjectDir = normalizeAbsoluteHostPath(projectDir);
  return normalizedProjectDir
    ? `${normalizedProjectDir}\0${sessionId}`
    : null;
}

export type CreateOrgXOpenCodePluginOptions = {
  startPeer?: StartPeer;
  env?: Env;
  logger?: Logger;
  bridgeSessionSummary?: BridgeSessionSummary;
  hydrateContextPack?: HydrateContextPack;
  clearSessionWorkContext?: ClearSessionWorkContext;
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
  let peer: Promise<StartedPeer> | null = null;
  const contextHydrations = new Map<
    string,
    Promise<ContextPackHydrationResult>
  >();
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
    if (runtimeHydration) return runtimeHydration;
    const key = contextHydrationKey(normalizedProjectDir, sessionId)!;
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
        await bridgeSessionSummary({
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
      }
    };

    return {
      'experimental.chat.system.transform': async (chatInput, output) => {
        const sessionId = nativeSessionId(chatInput);
        if (!sessionId) return;
        const result = await hydrateProjectContext(projectDir, sessionId);
        const additionalContext = result.additionalContext;
        if (
          typeof additionalContext !== 'string' ||
          !additionalContext ||
          Buffer.byteLength(additionalContext, 'utf8') >
            MAX_ADDITIONAL_CONTEXT_BYTES
        ) {
          return;
        }
        if (!output.system.includes(additionalContext)) {
          output.system.push(additionalContext);
        }
      },
      'chat.message': async (messageInput, output) => {
        const sessionId = nativeSessionId(messageInput);
        if (sessionId) {
          await hydrateProjectContext(projectDir, sessionId);
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
        if (event.type === 'session.created' && sessionId) {
          await hydrateProjectContext(projectDir, sessionId);
        }
        await capture(event.type, event);

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
          const key = contextHydrationKey(projectDir, sessionId);
          if (key) await contextHydrations.get(key);
          const clearance = await clearContext({
            env,
            projectDir,
            sessionId,
          }).catch((error) => {
            capturePluginException(error, {
              stage: 'session_context_clear',
            });
            return { cleared: false, reason: 'wizard_unavailable' } as const;
          });
          if (!clearance.cleared) {
            logger.warn(
              `[orgx-opencode-plugin] session context clear unverified: ${clearance.reason}`
            );
          }
          if (key) contextHydrations.delete(key);
          clearRuntimeSessionHydration(projectDir, sessionId);
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
          await hydrateProjectContext(projectDir, sessionId);
        }
        await capture('tool.execute.before', {
          ...toolInput,
          args: output?.args,
        });
      },
      'tool.execute.after': async (toolInput) => {
        const sessionId = nativeSessionId(toolInput);
        if (sessionId) {
          await hydrateProjectContext(projectDir, sessionId);
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
