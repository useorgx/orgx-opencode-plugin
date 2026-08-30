import { describe, expect, it, vi } from 'vitest';

import { createOrgXOpenCodePlugin } from './plugin';
import {
  clearRuntimeSessionHydration,
  publishRuntimeSessionHydration,
} from './runtimeSessionContext';

type Hooks = {
  event(input: { event: Record<string, unknown> & { type: string } }): Promise<void>;
  'chat.message'(
    input: { sessionID: string; messageID?: string },
    output: {
      message: { system?: string };
      parts: Array<Record<string, unknown>>;
    }
  ): Promise<void>;
  'tool.execute.before'(input: Record<string, unknown>): Promise<void>;
};

function logger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function hooks(
  opts: Parameters<typeof createOrgXOpenCodePlugin>[0]
): Promise<Hooks> {
  const plugin = createOrgXOpenCodePlugin({
    hydrateContextPack: vi.fn(async () => ({ ok: true })),
    clearSessionWorkContext: vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared',
    })),
    clearPrivateSessionContext: vi.fn(async () => ({
      cleared: true,
      reason: 'private_state_cleared',
      removedFiles: 1,
    })),
    ...opts,
  });
  return (await plugin({
    directory: '/work/repo',
    serverUrl: new URL('http://localhost:4096'),
  } as never)) as Hooks;
}

function sessionEvent(type: string, sessionID: string) {
  return { type, properties: { sessionID, info: { id: sessionID } } };
}

function assistantEvent(
  sessionID: string,
  error?: Record<string, unknown>
) {
  return {
    type: 'message.updated',
    properties: {
      sessionID,
      info: {
        id: 'assistant-1',
        sessionID,
        role: 'assistant',
        time: { created: 1, completed: 2 },
        ...(error ? { error } : {}),
      },
    },
  };
}

describe('OpenCode failed-start context recovery', () => {
  it('injects Wizard SessionStart context into the first model request', async () => {
    const hydrateContextPack = vi.fn(async () => ({
      ok: true,
      skipped: 'context_pack_unconfigured',
    } as const));
    const bridgeSessionSummary = vi.fn(async ({ nativeEvent }) =>
      nativeEvent === 'session.created'
        ? {
            ok: true,
            hook_output: {
              continue: true,
              suppressOutput: true,
              hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext:
                  'Objective: recover the exact activation. Decision: preserve owner atomicity. Source: OrgX accepted context.',
              },
            },
          }
        : { ok: true }
    );
    const active = await hooks({
      hydrateContextPack,
      bridgeSessionSummary,
      logger: logger(),
      env: {},
    });
    const sessionID = 'first-turn-context';
    const output = {
      message: { system: 'native system' },
      parts: [{ type: 'text', text: 'Continue the accepted task.' }],
    };

    await active.event({ event: sessionEvent('session.created', sessionID) });
    await active['chat.message']({ sessionID }, output);

    expect(output.message.system).toBe(
      'native system\n\nObjective: recover the exact activation. Decision: preserve owner atomicity. Source: OrgX accepted context.'
    );
    expect(hydrateContextPack).not.toHaveBeenCalled();
    expect(active).not.toHaveProperty('experimental.chat.system.transform');
  });

  it('claims local context before hydration when chat.message arrives first', async () => {
    const hydrateContextPack = vi.fn(async () => ({
      ok: true,
      skipped: 'context_pack_unconfigured',
    } as const));
    const bridgeSessionSummary = vi.fn(async ({ nativeEvent }) =>
      nativeEvent === 'session.created'
        ? {
            ok: true,
            hook_output: {
              continue: true,
              suppressOutput: true,
              hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: 'Locally claimed Wizard context',
              },
            },
          }
        : { ok: true }
    );
    const active = await hooks({
      hydrateContextPack,
      bridgeSessionSummary,
      logger: logger(),
      env: {},
    });
    const sessionID = 'chat-first';
    const output = {
      message: {},
      parts: [{ type: 'text', text: 'Continue.' }],
    };

    await active['chat.message']({ sessionID }, output);
    await active.event({ event: sessionEvent('session.created', sessionID) });

    expect(output.message.system).toBe('Locally claimed Wizard context');
    expect(hydrateContextPack).not.toHaveBeenCalled();
    expect(
      bridgeSessionSummary.mock.calls.map(([call]) => call.nativeEvent)
    ).toEqual(['session.created', 'chat.message']);
  });

  it('rejects an oversized SessionStart payload and uses bounded hydration', async () => {
    const hydrateContextPack = vi.fn(async () => ({
      ok: true,
      additionalContext: 'bounded fallback context',
    } as const));
    const bridgeSessionSummary = vi.fn(async () => ({
      ok: true,
      hook_output: {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'x'.repeat(9 * 1024),
        },
      },
    }));
    const active = await hooks({
      hydrateContextPack,
      bridgeSessionSummary,
      logger: logger(),
      env: {},
    });
    const output = {
      message: { system: 'native system' },
      parts: [{ type: 'text', text: 'Continue.' }],
    };

    await active.event({
      event: sessionEvent('session.created', 'oversized-start-context'),
    });
    await active['chat.message'](
      { sessionID: 'oversized-start-context' },
      output
    );

    expect(output.message.system).toBe(
      'native system\n\nbounded fallback context'
    );
    expect(hydrateContextPack).toHaveBeenCalledTimes(1);
  });

  it('does not append an oversized hydrated context to a user turn', async () => {
    const hydrateContextPack = vi.fn(async () => ({
      ok: true,
      additionalContext: 'x'.repeat(9 * 1024),
    } as const));
    const active = await hooks({
      hydrateContextPack,
      bridgeSessionSummary: vi.fn(async () => ({ ok: true })),
      logger: logger(),
      env: {},
    });
    const output = {
      message: { system: 'native system' },
      parts: [{ type: 'text', text: 'Continue.' }],
    };

    await active['chat.message']({ sessionID: 'oversized-hydration' }, output);

    expect(output.message.system).toBe('native system');
    expect(hydrateContextPack).toHaveBeenCalledTimes(1);
  });

  it('gives an exact Gateway hydration precedence over a local SessionStart result', async () => {
    const sessionID = 'gateway-precedence';
    const hydrateContextPack = vi.fn(async () => ({
      ok: true,
      additionalContext: 'ambient remote context',
    } as const));
    const bridgeSessionSummary = vi.fn(async ({ nativeEvent }) =>
      nativeEvent === 'session.created'
        ? {
            ok: true,
            hook_output: {
              continue: true,
              suppressOutput: true,
              hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: 'local staged context',
              },
            },
          }
        : { ok: true }
    );
    publishRuntimeSessionHydration('/work/repo', sessionID, {
      ok: true,
      additionalContext: 'exact Gateway context',
      sessionContext: { activated: true, reason: 'wizard_activated' },
    });
    try {
      const active = await hooks({
        hydrateContextPack,
        bridgeSessionSummary,
        logger: logger(),
        env: {},
      });
      const output = {
        message: {},
        parts: [{ type: 'text', text: 'Execute the dispatch.' }],
      };

      await active['chat.message']({ sessionID }, output);

      expect(output.message.system).toBe('exact Gateway context');
      expect(hydrateContextPack).not.toHaveBeenCalled();
    } finally {
      clearRuntimeSessionHydration('/work/repo', sessionID);
    }
  });

  it('releases an unused context after provider auth fails before model work', async () => {
    const clearSessionWorkContext = vi.fn();
    const clearPrivateSessionContext = vi.fn(async () => ({
      cleared: true,
      reason: 'private_state_cleared',
      removedFiles: 1,
    } as const));
    const bridgeSessionSummary = vi.fn(async ({ nativeEvent }) =>
      nativeEvent === 'session.abandoned'
        ? {
            ok: true,
            session_state_discarded: true,
            activation_released: true,
            activation_release_state: 'released',
          }
        : { ok: true }
    );
    const active = await hooks({
      clearSessionWorkContext,
      clearPrivateSessionContext,
      bridgeSessionSummary,
      logger: logger(),
      env: {},
    });
    const sessionID = 'provider-auth-failed';

    await active.event({ event: sessionEvent('session.created', sessionID) });
    await active['chat.message'](
      { sessionID, messageID: 'user-1' },
      {
        message: {},
        parts: [{ type: 'text', text: 'Continue the accepted task.' }],
      }
    );
    await active.event({
      event: assistantEvent(sessionID, {
        name: 'ProviderAuthError',
        data: { providerID: 'anthropic', message: 'reauth required' },
      }),
    });
    await active.event({ event: sessionEvent('session.error', sessionID) });
    await active.event({ event: sessionEvent('session.deleted', sessionID) });

    expect(
      bridgeSessionSummary.mock.calls.map(([call]) => call.nativeEvent)
    ).toEqual([
      'session.created',
      'chat.message',
      'message.updated',
      'session.abandoned',
    ]);
    expect(clearSessionWorkContext).not.toHaveBeenCalled();
    expect(clearPrivateSessionContext).toHaveBeenCalledWith({
      env: {},
      projectDir: '/work/repo',
      sessionId: sessionID,
    });
  });

  it('preserves exact owner state when unused-context release is unverified', async () => {
    const clearSessionWorkContext = vi.fn();
    const clearPrivateSessionContext = vi.fn();
    const bridgeSessionSummary = vi.fn(async ({ nativeEvent }) =>
      nativeEvent === 'session.abandoned'
        ? {
            ok: true,
            session_state_discarded: false,
            activation_released: false,
            activation_release_state: 'preserved',
          }
        : { ok: true }
    );
    const captureLogger = logger();
    const active = await hooks({
      clearSessionWorkContext,
      clearPrivateSessionContext,
      bridgeSessionSummary,
      logger: captureLogger,
      env: {},
    });
    const sessionID = 'release-unverified';

    await active.event({ event: sessionEvent('session.created', sessionID) });
    await active.event({ event: sessionEvent('session.deleted', sessionID) });

    expect(clearSessionWorkContext).not.toHaveBeenCalled();
    expect(clearPrivateSessionContext).not.toHaveBeenCalled();
    expect(captureLogger.warn).toHaveBeenCalledWith(
      '[orgx-opencode-plugin] unused session context release unverified; exact owner state was preserved'
    );
  });

  it('clears terminal context after a successful assistant completion', async () => {
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared',
    } as const));
    const clearPrivateSessionContext = vi.fn(async () => ({
      cleared: true,
      reason: 'private_state_cleared',
      removedFiles: 2,
    } as const));
    const bridgeSessionSummary = vi.fn(async ({ nativeEvent }) =>
      nativeEvent === 'session.idle'
        ? { ok: true, queued: true, state_persisted: true }
        : { ok: true }
    );
    const active = await hooks({
      clearSessionWorkContext,
      clearPrivateSessionContext,
      bridgeSessionSummary,
      logger: logger(),
      env: {},
    });
    const sessionID = 'assistant-completed';

    await active.event({ event: sessionEvent('session.created', sessionID) });
    await active.event({ event: assistantEvent(sessionID) });
    await active.event({ event: sessionEvent('session.idle', sessionID) });
    await active.event({ event: sessionEvent('session.deleted', sessionID) });

    expect(
      bridgeSessionSummary.mock.calls.map(([call]) => call.nativeEvent)
    ).toEqual([
      'session.created',
      'message.updated',
      'session.idle',
      'session.deleted',
    ]);
    expect(clearSessionWorkContext).toHaveBeenCalledTimes(1);
    expect(clearPrivateSessionContext).toHaveBeenCalledTimes(1);
  });

  it('records a bounded RunEnd before SessionEnd when native idle is missing', async () => {
    const bridgeSessionSummary = vi.fn(async ({ nativeEvent }) =>
      nativeEvent === 'session.idle'
        ? { ok: true, queued: true, state_persisted: true }
        : { ok: true }
    );
    const active = await hooks({
      bridgeSessionSummary,
      logger: logger(),
      env: {},
    });
    const sessionID = 'assistant-completed-without-idle';

    await active.event({ event: sessionEvent('session.created', sessionID) });
    await active.event({ event: assistantEvent(sessionID) });
    await active.event({ event: sessionEvent('session.deleted', sessionID) });

    expect(
      bridgeSessionSummary.mock.calls.map(([call]) => call.nativeEvent)
    ).toEqual([
      'session.created',
      'message.updated',
      'session.idle',
      'session.deleted',
    ]);
  });

  it('suppresses recovery when model-work consumption cannot be persisted', async () => {
    const bridgeSessionSummary = vi.fn(async ({ nativeEvent }) =>
      nativeEvent === 'session.idle'
        ? {
            ok: true,
            skipped: 'queue_write_failed',
            state_persisted: false,
            work_context_consumed: false,
          }
        : { ok: true }
    );
    const captureLogger = logger();
    const active = await hooks({
      bridgeSessionSummary,
      logger: captureLogger,
      env: {},
    });
    const sessionID = 'consumption-unverified';

    await active.event({ event: sessionEvent('session.created', sessionID) });
    await active.event({ event: assistantEvent(sessionID) });
    await active.event({ event: sessionEvent('session.deleted', sessionID) });

    expect(
      bridgeSessionSummary.mock.calls.map(([call]) => call.nativeEvent)
    ).toEqual(['session.created', 'message.updated', 'session.idle']);
    expect(captureLogger.warn).toHaveBeenCalledWith(
      '[orgx-opencode-plugin] model work consumption marker unverified; SessionEnd recovery was suppressed'
    );
  });

  it('treats a requested tool execution as real model work after a later error', async () => {
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared',
    } as const));
    const bridgeSessionSummary = vi.fn(async () => ({ ok: true }));
    const active = await hooks({
      clearSessionWorkContext,
      bridgeSessionSummary,
      logger: logger(),
      env: {},
    });
    const sessionID = 'tool-started';

    await active.event({ event: sessionEvent('session.created', sessionID) });
    await active['tool.execute.before']({
      sessionID,
      callID: 'tool-1',
      tool: 'bash',
    });
    await active.event({ event: sessionEvent('session.deleted', sessionID) });

    expect(
      bridgeSessionSummary.mock.calls.map(([call]) => call.nativeEvent)
    ).not.toContain('session.abandoned');
    expect(clearSessionWorkContext).toHaveBeenCalledTimes(1);
  });

  it('clears rather than requeues an unused Gateway-dispatched context', async () => {
    const sessionID = 'gateway-provider-auth-failed';
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared',
    } as const));
    const clearPrivateSessionContext = vi.fn(async () => ({
      cleared: true,
      reason: 'private_state_cleared',
      removedFiles: 1,
    } as const));
    const bridgeSessionSummary = vi.fn(async ({ nativeEvent }) =>
      nativeEvent === 'session.abandoned'
        ? {
            ok: true,
            session_state_discarded: true,
            activation_release_state: 'absent',
          }
        : { ok: true }
    );
    publishRuntimeSessionHydration('/work/repo', sessionID, {
      ok: true,
      additionalContext: 'Gateway-dispatched exact task context',
      sessionContext: { activated: true, reason: 'wizard_activated' },
    });
    try {
      const active = await hooks({
        clearSessionWorkContext,
        clearPrivateSessionContext,
        bridgeSessionSummary,
        logger: logger(),
        env: {},
      });

      await active.event({ event: sessionEvent('session.created', sessionID) });
      await active.event({
        event: assistantEvent(sessionID, {
          name: 'ProviderAuthError',
          data: { providerID: 'anthropic', message: 'reauth required' },
        }),
      });
      await active.event({ event: sessionEvent('session.deleted', sessionID) });

      expect(clearSessionWorkContext).toHaveBeenCalledTimes(1);
      expect(clearPrivateSessionContext).toHaveBeenCalledTimes(1);
      expect(
        bridgeSessionSummary.mock.calls.map(([call]) => call.nativeEvent)
      ).toContain('session.abandoned');
    } finally {
      clearRuntimeSessionHydration('/work/repo', sessionID);
    }
  });
});
