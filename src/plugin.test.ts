import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_PACK_FILENAME,
  PENDING_CONTEXT_FILENAME,
  clearPrivateSessionContext,
  resolvePrivateContextStateDirectory,
} from './contextPackHydration';
import { createOrgXOpenCodePlugin } from './plugin';
import {
  clearRuntimeSessionHydration,
  publishRuntimeSessionHydration,
} from './runtimeSessionContext';

type PluginHooks = {
  'chat.message': (
    input: { sessionID: string; messageID?: string },
    output: {
      message: { system?: string };
      parts: Array<Record<string, unknown>>;
    }
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
    clearPrivateSessionContext:
      opts?.clearPrivateSessionContext ??
      vi.fn(async () => ({
        cleared: true,
        reason: 'private_state_absent',
        removedFiles: 0,
      })),
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

  it('retries context before inference without resending it after model work', async () => {
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
    const first = { message: { system: 'native system' }, parts: [] };
    const retry = { message: {}, parts: [] };
    const afterCompletion = { message: {}, parts: [] };

    await hooks['chat.message']({ sessionID: 'session-1' }, first);
    await hooks['chat.message']({ sessionID: 'session-1' }, first);
    await hooks['chat.message']({ sessionID: 'session-1' }, retry);
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-1',
          info: {
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1, completed: 2 },
          },
        },
      },
    });
    await hooks['chat.message']({ sessionID: 'session-1' }, afterCompletion);

    expect(first.message.system).toBe(
      'native system\n\naccepted OrgX decision context'
    );
    expect(retry.message.system).toBe('accepted OrgX decision context');
    expect(afterCompletion.message.system).toBeUndefined();
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
      const output = { message: { system: 'native system' }, parts: [] };

      await hooks['chat.message']({ sessionID: sessionId }, output);

      expect(output.message.system).toBe(
        'native system\n\nexact dispatched task context'
      );
      expect(output.message.system).not.toContain('ambient workspace context');
    } finally {
      clearRuntimeSessionHydration('/work/repo', sessionId);
    }
  });

  it('does not expose context through the auxiliary system-transform hook', async () => {
    const hooks = await loadHooks({
      logger: createLogger(),
      env: {},
    });

    expect(hooks).not.toHaveProperty('experimental.chat.system.transform');
  });

  it('isolates hydration caches by native session and drops a deleted session', async () => {
    const hydrateContextPack = vi.fn(async () => ({ ok: true } as const));
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared',
    } as const));
    const clearPrivateSessionContext = vi.fn(async () => ({
      cleared: true,
      reason: 'private_state_cleared',
      removedFiles: 2,
    } as const));
    const hooks = await loadHooks({
      hydrateContextPack,
      clearSessionWorkContext,
      clearPrivateSessionContext,
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
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-a',
          info: {
            sessionID: 'session-a',
            role: 'assistant',
            time: { created: 1, completed: 2 },
          },
        },
      },
    });
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
    expect(clearPrivateSessionContext).toHaveBeenCalledTimes(1);
    expect(clearPrivateSessionContext).toHaveBeenCalledWith({
      env: {
        ORGX_WORKSPACE_ID: 'workspace-123',
      },
      projectDir: '/work/repo',
      sessionId: 'session-a',
    });
  });

  it('removes only the deleted session owner-state files at the terminal event', async () => {
    const projectDir = mkdtempSync(
      join(tmpdir(), 'orgx-opencode-plugin-project-')
    );
    const wizardHome = mkdtempSync(
      join(tmpdir(), 'orgx-opencode-plugin-state-')
    );
    const env = { ORGX_WIZARD_CONFIG_HOME: wizardHome };
    const stateDir = (sessionId: string) =>
      resolvePrivateContextStateDirectory({ env, projectDir, sessionId })!;
    try {
      for (const sessionId of ['session-a', 'session-b']) {
        mkdirSync(stateDir(sessionId), { recursive: true });
        writeFileSync(
          join(stateDir(sessionId), CONTEXT_PACK_FILENAME),
          `${sessionId}-pack`
        );
        writeFileSync(
          join(stateDir(sessionId), PENDING_CONTEXT_FILENAME),
          `${sessionId}-pending`
        );
      }
      const hooks = await loadHooks(
        {
          env,
          clearPrivateSessionContext,
          logger: createLogger(),
        },
        {
          directory: projectDir,
          serverUrl: new URL('http://localhost:4096'),
        }
      );

      await hooks.event({
        event: {
          type: 'message.updated',
          properties: {
            sessionID: 'session-a',
            info: {
              sessionID: 'session-a',
              role: 'assistant',
              time: { created: 1, completed: 2 },
            },
          },
        },
      });

      await hooks.event({
        event: {
          type: 'session.deleted',
          properties: { info: { id: 'session-a' } },
        },
      });

      expect(
        existsSync(join(stateDir('session-a'), CONTEXT_PACK_FILENAME))
      ).toBe(false);
      expect(
        existsSync(join(stateDir('session-a'), PENDING_CONTEXT_FILENAME))
      ).toBe(false);
      expect(
        existsSync(join(stateDir('session-b'), CONTEXT_PACK_FILENAME))
      ).toBe(true);
      expect(
        existsSync(join(stateDir('session-b'), PENDING_CONTEXT_FILENAME))
      ).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(wizardHome, { recursive: true, force: true });
    }
  });

  it('waits for in-flight hydration before releasing an unused terminal session lease', async () => {
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
    const bridgeSessionSummary = vi.fn(async ({ nativeEvent }) =>
      nativeEvent === 'session.abandoned'
        ? {
            ok: true,
            state_persisted: true,
            activation_released: true,
            activation_release_state: 'released',
          }
        : { ok: true }
    );
    const hooks = await loadHooks({
      hydrateContextPack,
      clearSessionWorkContext,
      bridgeSessionSummary,
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
    expect(
      bridgeSessionSummary.mock.calls.map(([call]) => call.nativeEvent)
    ).not.toContain('session.abandoned');

    finishHydration?.();
    await Promise.all([creating, deleting]);
    expect(clearSessionWorkContext).not.toHaveBeenCalled();
    expect(
      bridgeSessionSummary.mock.calls.map(([call]) => call.nativeEvent)
    ).toContain('session.abandoned');
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
        message: {},
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
      'session.created',
      'chat.message',
      'tool.execute.before',
      'tool.execute.after',
    ]);
    expect(bridgeSessionSummary.mock.calls[2][0].payload).toEqual({
      sessionID: 'session-1',
      messageID: 'message-1',
      prompt: 'Implement the work episode.',
    });
  });
});
