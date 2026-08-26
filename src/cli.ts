#!/usr/bin/env node
/**
 * Minimal CLI entrypoint so users can run:
 *
 *   ORGX_API_KEY=oxk_...  ORGX_WORKSPACE_ID=...  orgx-opencode-plugin
 */

import { startPeer } from './peer.js';
import { captureFatalPluginException } from './sentry.js';
import { captureGatewayCredential } from './childProcessEnv.js';

async function main() {
  const apiKey = captureGatewayCredential(process.env);
  const workspaceId = process.env.ORGX_WORKSPACE_ID;
  const baseUrl = process.env.ORGX_BASE_URL ?? 'https://useorgx.com';
  const openCodeServerUrl =
    process.env.OPENCODE_SERVER_URL ?? process.env.ORGX_OPENCODE_SERVER_URL;

  if (!apiKey || !workspaceId) {
    // eslint-disable-next-line no-console
    console.error(
      'Missing ORGX_API_KEY (or ORGX_GATEWAY_KEY) and/or ORGX_WORKSPACE_ID. Export both and retry.'
    );
    process.exit(2);
  }

  const peer = await startPeer({
    apiKey,
    workspaceId,
    baseUrl,
    openCodeServerUrl,
    openCodeDirectory: process.cwd(),
  });

  const shutdown = async () => {
    await peer.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // eslint-disable-next-line no-console
  console.log(
    '[orgx-opencode-plugin] peer running — ctrl-c to stop. Dispatches will arrive when OrgX sends them.'
  );
}

main().catch(async (err) => {
  await captureFatalPluginException(err);
  // eslint-disable-next-line no-console
  console.error('[orgx-opencode-plugin] fatal', err);
  process.exit(1);
});
