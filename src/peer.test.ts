import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('@useorgx/orgx-gateway-sdk', () => ({
  PeerClient: class {
    constructor(options: Record<string, unknown>) {
      sdk.options = options;
    }

    connect() {
      sdk.connect();
    }

    disconnect() {
      sdk.disconnect();
    }
  },
}));

import { startPeer } from './peer.js';

describe('startPeer', () => {
  beforeEach(() => {
    sdk.options = undefined;
    sdk.connect.mockClear();
    sdk.disconnect.mockClear();
  });

  it('pins production negotiation to Gateway protocol v1 until proof finalization exists', async () => {
    const driver = {
      id: 'opencode',
      detect: vi.fn(),
      dispatch: vi.fn(),
      cancel: vi.fn(),
    };

    const peer = await startPeer({
      apiKey: 'oxk_test_only',
      workspaceId: 'workspace-test',
      driver,
      skipHeartbeat: true,
    });

    expect(sdk.options).toMatchObject({
      pluginId: '@useorgx/orgx-opencode-plugin',
      protocolVersion: 1,
      drivers: [driver],
    });
    expect(sdk.connect).toHaveBeenCalledOnce();

    await peer.stop();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
  });
});
