import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { startPeer, summarizeTransportError } from './peer.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

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
      pluginId: 'orgx-opencode-plugin',
      protocolVersion: 1,
      drivers: [driver],
    });
    expect(sdk.connect).toHaveBeenCalledOnce();

    await peer.stop();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
  });

  it('advertises exact activation and provider-observation heartbeat keys', async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown>;
      redirect?: RequestRedirect;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? '{}')),
          redirect: init?.redirect,
        });
        return new Response('{}', { status: 200 });
      })
    );
    const driver = {
      id: 'opencode' as const,
      detect: vi.fn(async () => ({
        installed: true,
        authenticated: true,
        version: '1.18.2',
      })),
      probe: vi.fn(async () => ({
        subscription_active: true,
        session_alive: true,
      })),
      dispatch: vi.fn(),
      cancel: vi.fn(),
    };

    const peer = await startPeer({
      apiKey: 'oxk_test_only',
      workspaceId: 'workspace-test',
      driver,
      continuityOutbox: {
        state: 'ready',
        pending: 0,
        dead_letters: 0,
        last_replay_at: null,
      },
      autoReplayWorkGraph: false,
    });
    const presence = requests.find(({ url }) =>
      url.endsWith('/api/v1/gateway/heartbeat')
    );

    expect(presence?.body).toMatchObject({
      gateway_version: '0.1.0-alpha.17',
      metadata: {
        execution_provider: null,
        execution_provider_id: null,
        execution_provider_observed_at: null,
        execution_auth_method: null,
        capabilities: {
          session_context_activation_v1: true,
          session_context_acceptance_v1: true,
        },
      },
    });
    expect(requests.every(({ redirect }) => redirect === 'error')).toBe(true);

    await peer.stop();
  });

  it('rejects an unsafe OrgX base URL before opening a credentialed transport', async () => {
    const driver = {
      id: 'opencode',
      detect: vi.fn(),
      dispatch: vi.fn(),
      cancel: vi.fn(),
    };

    await expect(
      startPeer({
        apiKey: 'oxk_test_only',
        workspaceId: 'workspace-test',
        baseUrl: 'http://untrusted.example.test',
        driver,
        skipHeartbeat: true,
      })
    ).rejects.toThrow('Unsafe OrgX base URL');
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it('redacts and bounds terminal close reasons before logging', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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

    (sdk.options?.onClose as ((code: number, reason: string) => void) | undefined)?.(
      4401,
      `Bearer oxk_private_secret ${'x'.repeat(1_000)}`
    );

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('oxk_private_secret');
    expect(logged.length).toBeLessThan(800);
    await peer.stop();
  });
});

describe('summarizeTransportError', () => {
  it('drops transport internals and redacts credentials in the message', () => {
    const summary = summarizeTransportError({
      name: 'ErrorEvent',
      message: 'Unexpected server response: 401 Bearer oxk_test_secret',
      target: {
        request: {
          header: 'Sec-WebSocket-Protocol: orgx.v1,bearer.oxk_test_secret',
        },
      },
    });

    expect(summary).toEqual({
      name: 'ErrorEvent',
      message: 'Unexpected server response: 401 Bearer [redacted]',
    });
    expect(JSON.stringify(summary)).not.toContain('test_secret');
  });
});
