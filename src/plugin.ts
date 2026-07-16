import type { Plugin } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import type { StartedPeer, StartPeerOptions } from './peer.js';
import { hydrateContextPack } from './contextPackHydration.js';
import { capturePluginException } from './sentry.js';
import {
  bridgeOpenCodeQuestions,
  parseQuestionRequest,
} from './attentionBridge.js';

type StartPeer = (opts: StartPeerOptions) => Promise<StartedPeer>;
type Env = Record<string, string | undefined>;
type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export type CreateOrgXOpenCodePluginOptions = {
  startPeer?: StartPeer;
  env?: Env;
  logger?: Logger;
};

export function createOrgXOpenCodePlugin(
  opts: CreateOrgXOpenCodePluginOptions = {}
): Plugin {
  const start = opts.startPeer ?? defaultStartPeer;
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? console;
  let peer: Promise<StartedPeer> | null = null;
  let warnedMissingConfig = false;
  let warnedMissingAttentionConfig = false;
  const activeAttention = new Set<string>();

  async function startIfConfigured() {
    if (peer) return;

    const apiKey = env.ORGX_API_KEY;
    const workspaceId = env.ORGX_WORKSPACE_ID;
    const baseUrl = env.ORGX_BASE_URL;

    if (!apiKey || !workspaceId) {
      if (!warnedMissingConfig) {
        logger.warn(
          '[orgx-opencode-plugin] native plugin loaded, but ORGX_API_KEY and ORGX_WORKSPACE_ID are required to connect'
        );
        warnedMissingConfig = true;
      }
      return;
    }

    peer = start({ apiKey, workspaceId, baseUrl });
    try {
      await peer;
      logger.log('[orgx-opencode-plugin] native OpenCode plugin peer started');
    } catch (err) {
      peer = null;
      capturePluginException(err, { stage: 'native_plugin_start' });
      logger.error('[orgx-opencode-plugin] failed to start peer', formatError(err));
    }
  }

  return async (input) => ({
    event: async ({ event }: { event: { type?: string } }) => {
      if (event.type === 'server.connected') {
        await startIfConfigured();
        // M adapter: hydrate the context pack (best-effort, never throws).
        void hydrateContextPack(env);
      }

      if (env.ORGX_REMOTE_ATTENTION !== '1') return;
      const questionRequest = parseQuestionRequest(event);
      if (!questionRequest || activeAttention.has(questionRequest.id)) return;

      const apiKey = env.ORGX_API_KEY;
      const initiativeId = env.ORGX_INITIATIVE_ID;
      if (!apiKey || !initiativeId) {
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
        directory: input.directory,
      });
      void bridgeOpenCodeQuestions({
        request: questionRequest,
        apiKey,
        initiativeId,
        runId: env.ORGX_RUN_ID,
        workstreamId: env.ORGX_WORKSTREAM_ID,
        baseUrl: env.ORGX_BASE_URL,
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
  });
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
