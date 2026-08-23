import { describe, expect, it, vi } from 'vitest';

import { createOrgXOpenCodePlugin } from './plugin';

type PluginHooks = {
  event: (input: { event: { type?: string } }) => Promise<void>;
  'tool.execute.before': (input: Record<string, unknown>) => Promise<void>;
  'tool.execute.after': (input: Record<string, unknown>) => Promise<void>;
};

function createLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function loadHooks(
  opts: Parameters<typeof createOrgXOpenCodePlugin>[0]
): Promise<PluginHooks> {
  const plugin = createOrgXOpenCodePlugin({
    ...(opts ?? {}),
    bridgeSessionSummary:
      opts?.bridgeSessionSummary ?? vi.fn(async () => ({ ok: true })),
  });
  return (await plugin({} as never)) as PluginHooks;
}

describe('OrgXOpenCodePlugin', () => {
  it('starts the peer on server.connected with env config', async () => {
    const stop = vi.fn();
    const startPeer = vi.fn(async () => ({ stop }));
    const logger = createLogger();
    const env = {
      ORGX_API_KEY: 'oxk_test',
      ORGX_GATEWAY_KEY: 'oxk_alias',
      ORGX_WORKSPACE_ID: 'workspace-123',
      ORGX_BASE_URL: 'https://example.org',
    };
    const hooks = await loadHooks({
      startPeer,
      logger,
      env,
    });

    expect(env).toEqual({
      ORGX_WORKSPACE_ID: 'workspace-123',
      ORGX_BASE_URL: 'https://example.org',
    });

    await hooks.event({ event: { type: 'session.created' } });
    expect(startPeer).not.toHaveBeenCalled();

    await hooks.event({ event: { type: 'server.connected' } });
    expect(startPeer).toHaveBeenCalledTimes(1);
    expect(startPeer).toHaveBeenCalledWith({
      apiKey: 'oxk_test',
      workspaceId: 'workspace-123',
      baseUrl: 'https://example.org',
    });
    expect(logger.log).toHaveBeenCalledWith(
      '[orgx-opencode-plugin] native OpenCode plugin peer started'
    );
  });

  it('does not start more than once', async () => {
    const startPeer = vi.fn(async () => ({ stop: vi.fn() }));
    const logger = createLogger();
    const hooks = await loadHooks({
      startPeer,
      logger,
      env: {
        ORGX_API_KEY: 'oxk_test',
        ORGX_WORKSPACE_ID: 'workspace-123',
      },
    });

    await hooks.event({ event: { type: 'server.connected' } });
    await hooks.event({ event: { type: 'server.connected' } });

    expect(startPeer).toHaveBeenCalledTimes(1);
  });

  it('warns once when required env config is missing', async () => {
    const startPeer = vi.fn(async () => ({ stop: vi.fn() }));
    const logger = createLogger();
    const hooks = await loadHooks({
      startPeer,
      logger,
      env: {},
    });

    await hooks.event({ event: { type: 'server.connected' } });
    await hooks.event({ event: { type: 'server.connected' } });

    expect(startPeer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[orgx-opencode-plugin] native plugin loaded, but ORGX_API_KEY and ORGX_WORKSPACE_ID are required to connect'
    );
  });

  it('logs start failures without throwing through OpenCode hooks', async () => {
    const startPeer = vi.fn(async () => {
      throw new Error('connect failed');
    });
    const logger = createLogger();
    const hooks = await loadHooks({
      startPeer,
      logger,
      env: {
        ORGX_API_KEY: 'oxk_test',
        ORGX_WORKSPACE_ID: 'workspace-123',
      },
    });

    await expect(
      hooks.event({ event: { type: 'server.connected' } })
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      '[orgx-opencode-plugin] failed to start peer',
      'connect failed'
    );
  });

  it('exposes exactly one callable plugin from the package root', async () => {
    const mod = await import('./index');

    expect(Object.keys(mod)).toEqual(['OrgXOpenCodePlugin']);
    expect(typeof mod.OrgXOpenCodePlugin).toBe('function');
  });

  it('keeps peer and driver helpers on the explicit SDK entry', async () => {
    const mod = await import('./sdk');

    expect(typeof mod.OrgXOpenCodePlugin).toBe('function');
    expect(typeof mod.OpenCodeDriver).toBe('function');
    expect(typeof mod.startPeer).toBe('function');
  });

  it('observes session and tool lifecycle through the shared summary bridge', async () => {
    const bridgeSessionSummary = vi.fn(async () => ({ ok: true }));
    const hooks = await loadHooks({
      bridgeSessionSummary,
      env: {},
      logger: createLogger(),
    });

    await hooks.event({ event: { type: 'session.idle' } });
    await hooks['tool.execute.before']({
      sessionID: 'session-1',
      callID: 'call-1',
      tool: 'bash',
    });
    await hooks['tool.execute.after']({
      sessionID: 'session-1',
      callID: 'call-1',
      tool: 'bash',
    });

    expect(bridgeSessionSummary.mock.calls.map(([call]) => call.nativeEvent)).toEqual([
      'session.idle',
      'tool.execute.before',
      'tool.execute.after',
    ]);
  });
});
