export { OpenCodeDriver, type OpenCodeDriverOptions } from './OpenCodeDriver.js';
export {
  createOrgXOpenCodePlugin,
  OrgXOpenCodePlugin,
  type CreateOrgXOpenCodePluginOptions,
} from './plugin.js';
export type { StartedPeer, StartPeerOptions } from './peer.js';
export {
  buildWorkGraphEventRecord,
  recordWorkGraphEvent,
  resolveWorkGraphOutboxPath,
} from './workGraphOutbox.js';
export { inspectOpenCodeV2Canary } from './v2Canary.js';

export async function startPeer(
  opts: import('./peer.js').StartPeerOptions
): Promise<import('./peer.js').StartedPeer> {
  const peer = await import('./peer.js');
  return peer.startPeer(opts);
}
