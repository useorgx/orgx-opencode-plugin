import type { Plugin } from '@opencode-ai/plugin';

import type { StartedPeer, StartPeerOptions } from './peer.js';
import { hydrateContextPack } from './contextPackHydration.js';
import { capturePluginException } from './sentry.js';

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

  return async () => ({
    event: async ({ event }: { event: { type?: string } }) => {
      if (event.type === 'server.connected') {
        await startIfConfigured();
        // M adapter: hydrate the context pack (best-effort, never throws).
        void hydrateContextPack(env);
      }
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
