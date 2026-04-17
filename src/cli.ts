#!/usr/bin/env node
/**
 * Minimal CLI entrypoint so users can run:
 *
 *   ORGX_API_KEY=oxk_...  ORGX_WORKSPACE_ID=...  orgx-opencode-plugin
 */

import { startPeer } from './peer.js';

async function main() {
  const apiKey = process.env.ORGX_API_KEY;
  const workspaceId = process.env.ORGX_WORKSPACE_ID;
  const baseUrl = process.env.ORGX_BASE_URL ?? 'https://useorgx.com';

  if (!apiKey || !workspaceId) {
    // eslint-disable-next-line no-console
    console.error(
      'Missing ORGX_API_KEY and/or ORGX_WORKSPACE_ID. Export both and retry.'
    );
    process.exit(2);
  }

  const peer = await startPeer({ apiKey, workspaceId, baseUrl });

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

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[orgx-opencode-plugin] fatal', err);
  process.exit(1);
});
