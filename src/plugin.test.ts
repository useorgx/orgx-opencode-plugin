import { describe, expect, it, vi } from 'vitest';

import { createOrgXOpenCodePlugin } from './plugin';
import {
  clearRuntimeSessionHydration,
  publishRuntimeSessionHydration,
} from './runtimeSessionContext';

type PluginHooks = {
  'experimental.chat.system.transform': (
    input: { sessionID?: string },
    output: { system: string[] }
  ) => Promise<void>;
  'chat.message': (
    input: { sessionID: string; messageID?: string },
    output: { parts: Array<Record<string, unknown>> }
  ) => Promise<void>;
  event: (input: {
    event: Record<string, unknown> & { type: string };
  }) => Promise<void>;
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
  opts: Parameters<typeof createOrgXOpenCodePlugin>[0],
  input: Record<string, unknown> = {
    directory: '/work/repo',
    serverUrl: new URL('http://localhost:4096'),
  }
): Promise<PluginHooks> {
  const plugin = createOrgXOpenCodePlugin({
    ...(opts ?? {}),
    bridgeSessionSummary:
      opts?.bridgeSessionSummary ?? vi.fn(async () => ({ ok: true })),
    hydrateContextPack:
      opts?.hydrateContextPack ?? vi.fn(async () => ({ ok: true })),
    clearSessionWorkContext:
      opts?.clearSessionWorkContext ??
      vi.fn(async () => ({ cleared: true, reason: 'wizard_cleared' })),
  });
  return (await plugin(input as never)) as PluginHooks;
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
      openCodeServerUrl: 'http://localhost:4096/',
      openCodeDirectory: '/work/repo',
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

  it('hydrates exactly once per native session against the OpenCode project directory', async () => {
    const hydrateContextPack = vi.fn(async () => ({ ok: true } as const));
    const startPeer = vi.fn(async () => ({ stop: vi.fn() }));
    const hooks = await loadHooks({
      startPeer,
      hydrateContextPack,
      logger: createLogger(),
      env: {
        ORGX_API_KEY: 'oxk_test',
        ORGX_GATEWAY_KEY: 'oxk_alias',
        ORGX_WORKSPACE_ID: 'workspace-123',
        ORGX_TASK_ID: 'task-456',
      },
    });

    const created = {
      type: 'session.created',
      properties: { info: { id: 'session-1' } },
    };
    await hooks.event({ event: created });
    await hooks.event({ event: created });
    await hooks.event({ event: { type: 'server.connected' } });

    expect(hydrateContextPack).toHaveBeenCalledTimes(1);
    expect(hydrateContextPack).toHaveBeenCalledWith({
      disabled: false,
      env: {
        ORGX_API_KEY: 'oxk_test',
        ORGX_BASE_URL: 'https://useorgx.com',
        ORGX_WORKSPACE_ID: 'workspace-123',
        ORGX_TASK_ID: 'task-456',
      },
      projectDir: '/work/repo',
      sessionId: 'session-1',
    });
  });

  it('waits for bounded context activation before session.created completes', async () => {
    let finishHydration: (() => void) | undefined;
    const hydrateContextPack = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finishHydration = () => resolve({ ok: true });
        })
    );
    const hooks = await loadHooks({
      hydrateContextPack,
      startPeer: vi.fn(async () => ({ stop: vi.fn() })),
      logger: createLogger(),
      env: {
        ORGX_API_KEY: 'oxk_test',
        ORGX_WORKSPACE_ID: 'workspace-123',
      },
    });
    let completed = false;

    const connecting = hooks
      .event({
        event: {
          type: 'session.created',
          properties: { info: { id: 'session-1' } },
        },
      })
      .then(() => {
        completed = true;
      });
    await vi.waitFor(() => expect(hydrateContextPack).toHaveBeenCalledTimes(1));
    expect(completed).toBe(false);

    finishHydration?.();
    await connecting;
    expect(completed).toBe(true);
  });

  it('injects compiled context into every model request without duplicating one output', async () => {
    const hydrateContextPack = vi.fn(async () => ({
      ok: true,
      additionalContext: 'accepted OrgX decision context',
    } as const));
    const hooks = await loadHooks({
      hydrateContextPack,
      startPeer: vi.fn(async () => ({ stop: vi.fn() })),
      logger: createLogger(),
      env: {
        ORGX_API_KEY: 'oxk_test',
        ORGX_WORKSPACE_ID: 'workspace-123',
      },
    });
    const first = { system: ['native system'] };
    const second = { system: ['native system'] };

    await hooks['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      first
    );
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      second
    );
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'session-1' },
      second
    );

    expect(first.system).toEqual([
      'native system',
      'accepted OrgX decision context',
    ]);
    expect(second.system).toEqual([
      'native system',
      'accepted OrgX decision context',
    ]);
    expect(hydrateContextPack).toHaveBeenCalledTimes(1);
  });

  it('lets exact driver scope replace an earlier ambient session hydration', async () => {
    const sessionId = 'runtime-scoped-session';
    const hydrateContextPack = vi.fn(async () => ({
      ok: true,
      additionalContext: 'ambient workspace context',
    } as const));
    const hooks = await loadHooks({
      hydrateContextPack,
      logger: createLogger(),
      env: {
        ORGX_API_KEY: 'oxk_test',
        ORGX_WORKSPACE_ID: 'workspace-123',
      },
    });
    try {
      await hooks.event({
        event: {
          type: 'session.created',
          properties: { info: { id: sessionId } },
        },
      });
      publishRuntimeSessionHydration('/work/repo', sessionId, {
        ok: true,
        additionalContext: 'exact dispatched task context',
        sessionContext: {
          activated: true,
          reason: 'wizard_activated',
        },
      });
      const output = { system: ['native system'] };

      await hooks['experimental.chat.system.transform'](
        { sessionID: sessionId },
        output
      );

      expect(output.system).toEqual([
        'native system',
        'exact dispatched task context',
      ]);
      expect(output.system).not.toContain('ambient workspace context');
    } finally {
      clearRuntimeSessionHydration('/work/repo', sessionId);
    }
  });

  it('does not hydrate or inject into sessionless internal agent generation', async () => {
    const hydrateContextPack = vi.fn(async () => ({
      ok: true,
      additionalContext: 'must remain session-bound',
    } as const));
    const hooks = await loadHooks({
      hydrateContextPack,
      logger: createLogger(),
      env: {
        ORGX_API_KEY: 'oxk_test',
        ORGX_WORKSPACE_ID: 'workspace-123',
      },
    });
    const output = { system: ['native system'] };

    await hooks['experimental.chat.system.transform']({}, output);

    expect(hydrateContextPack).not.toHaveBeenCalled();
    expect(output.system).toEqual(['native system']);
  });

  it('isolates hydration caches by native session and drops a deleted session', async () => {
    const hydrateContextPack = vi.fn(async () => ({ ok: true } as const));
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared',
    } as const));
    const hooks = await loadHooks({
      hydrateContextPack,
      clearSessionWorkContext,
      logger: createLogger(),
      env: {
        ORGX_API_KEY: 'oxk_test',
        ORGX_WORKSPACE_ID: 'workspace-123',
      },
    });
    const sessionEvent = (type: string, id: string) => ({
      type,
      properties: { info: { id } },
    });

    await hooks.event({ event: sessionEvent('session.created', 'session-a') });
    await hooks.event({ event: sessionEvent('session.created', 'session-b') });
    await hooks.event({ event: sessionEvent('session.deleted', 'session-a') });
    await hooks.event({ event: sessionEvent('session.created', 'session-a') });

    expect(
      hydrateContextPack.mock.calls.map(([call]) => call.sessionId)
    ).toEqual(['session-a', 'session-b', 'session-a']);
    expect(clearSessionWorkContext).toHaveBeenCalledWith({
      env: {
        ORGX_WORKSPACE_ID: 'workspace-123',
      },
      projectDir: '/work/repo',
      sessionId: 'session-a',
    });
  });

  it('waits for in-flight hydration before clearing the terminal session lease', async () => {
    let finishHydration: (() => void) | undefined;
    const hydrateContextPack = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finishHydration = () => resolve({ ok: true });
        })
    );
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared',
    } as const));
    const hooks = await loadHooks({
      hydrateContextPack,
      clearSessionWorkContext,
      logger: createLogger(),
      env: {},
    });
    const properties = { info: { id: 'session-race' } };

    const creating = hooks.event({
      event: { type: 'session.created', properties },
    });
    await vi.waitFor(() => expect(hydrateContextPack).toHaveBeenCalledTimes(1));
    const deleting = hooks.event({
      event: { type: 'session.deleted', properties },
    });
    await Promise.resolve();
    expect(clearSessionWorkContext).not.toHaveBeenCalled();

    finishHydration?.();
    await Promise.all([creating, deleting]);
    expect(clearSessionWorkContext).toHaveBeenCalledWith({
      env: {},
      projectDir: '/work/repo',
      sessionId: 'session-race',
    });
  });

  it('does not send a credential-bearing base override to any network path', async () => {
    const startPeer = vi.fn(async () => ({ stop: vi.fn() }));
    const hydrateContextPack = vi.fn(async () => ({ ok: true } as const));
    const bridgeSessionSummary = vi.fn(async () => ({ ok: true }));
    const logger = createLogger();
    const env = {
      ORGX_API_KEY: 'oxk_test',
      ORGX_WORKSPACE_ID: 'workspace-123',
      ORGX_BASE_URL: 'https://user:secret@example.test?token=private',
    };
    const hooks = await loadHooks({
      startPeer,
      hydrateContextPack,
      bridgeSessionSummary,
      logger,
      env,
    });

    await hooks.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'session-private' } },
      },
    });
    await hooks.event({ event: { type: 'server.connected' } });

    expect(startPeer).not.toHaveBeenCalled();
    expect(hydrateContextPack).toHaveBeenCalledWith({
      disabled: true,
      env: {
        ORGX_API_KEY: 'oxk_test',
        ORGX_BASE_URL: undefined,
        ORGX_WORKSPACE_ID: 'workspace-123',
      },
      projectDir: '/work/repo',
      sessionId: 'session-private',
    });
    expect(bridgeSessionSummary.mock.calls[0][0].env).toEqual({
      ORGX_WORKSPACE_ID: 'workspace-123',
    });
    expect(env).toEqual({ ORGX_WORKSPACE_ID: 'workspace-123' });
    expect(logger.warn).toHaveBeenCalledWith(
      '[orgx-opencode-plugin] native plugin loaded, but ORGX_BASE_URL is not a credential-free HTTPS or loopback HTTP URL'
    );
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
    await hooks['chat.message'](
      { sessionID: 'session-1', messageID: 'message-1' },
      {
        parts: [
          { type: 'text', text: 'Implement the work episode.' },
          { type: 'text', text: 'hidden', synthetic: true },
          { type: 'file', url: 'private-file' },
        ],
      }
    );
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
      'chat.message',
      'tool.execute.before',
      'tool.execute.after',
    ]);
    expect(bridgeSessionSummary.mock.calls[1][0].payload).toEqual({
      sessionID: 'session-1',
      messageID: 'message-1',
      prompt: 'Implement the work episode.',
    });
  });
});
