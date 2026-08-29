import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ActivationAcceptanceBroker,
  createActivationObservingWebSocketFactory,
} from './activationAcceptance';

const EXPECTATION = {
  runId: 'run-1',
  contextSha256: `sha256:${'a'.repeat(64)}` as const,
  activationSha256: `sha256:${'c'.repeat(64)}` as const,
  nativeSessionId: 'session-1',
};

function acceptedFrame(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'task.activation.accepted',
    schema_version: 'orgx-gateway-session-context-activation-accepted/v1',
    source_client: 'opencode',
    run_id: 'run-1',
    context_sha256: EXPECTATION.contextSha256,
    activation_sha256: EXPECTATION.activationSha256,
    native_session_id: 'session-1',
    accepted_at: '2026-08-26T17:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ActivationAcceptanceBroker', () => {
  it('resolves only the exact durable acceptance tuple', async () => {
    const broker = new ActivationAcceptanceBroker(100);
    const accepted = broker.waitForAcceptance(EXPECTATION);

    expect(
      broker.observe(
        JSON.stringify(acceptedFrame())
      )
    ).toBe(true);
    await expect(accepted).resolves.toBeUndefined();
  });

  it('rejects an explicit Gateway rejection', async () => {
    const broker = new ActivationAcceptanceBroker(100);
    const accepted = broker.waitForAcceptance(EXPECTATION);

    broker.observe({
      kind: 'task.activation.rejected',
      run_id: 'run-1',
      reason: 'server-only detail',
    });

    await expect(accepted).rejects.toThrow(
      'Gateway rejected OrgX context activation'
    );
  });

  it('rejects a mismatched digest or native session instead of ignoring it', async () => {
    const broker = new ActivationAcceptanceBroker(100);
    const accepted = broker.waitForAcceptance(EXPECTATION);

    broker.observe(acceptedFrame({
      context_sha256: `sha256:${'b'.repeat(64)}`,
      native_session_id: 'wrong-session',
    }));

    await expect(accepted).rejects.toThrow(
      'Gateway context activation acceptance mismatch'
    );
  });

  it('rejects a matching tuple carried by the wrong acceptance contract', async () => {
    const broker = new ActivationAcceptanceBroker(100);
    const accepted = broker.waitForAcceptance(EXPECTATION);

    broker.observe(
      acceptedFrame({
        schema_version: 'orgx-gateway-session-context-activation-accepted/v0',
      })
    );

    await expect(accepted).rejects.toThrow(
      'Gateway context activation acceptance mismatch'
    );
  });

  it('rejects an acceptance with the wrong full-activation digest', async () => {
    const broker = new ActivationAcceptanceBroker(100);
    const accepted = broker.waitForAcceptance(EXPECTATION);

    broker.observe(
      acceptedFrame({ activation_sha256: `sha256:${'d'.repeat(64)}` })
    );

    await expect(accepted).rejects.toThrow(
      'Gateway context activation acceptance mismatch'
    );
  });

  it('rejects when the exact acceptance never arrives', async () => {
    vi.useFakeTimers();
    const broker = new ActivationAcceptanceBroker(25);
    const assertion = expect(
      broker.waitForAcceptance(EXPECTATION)
    ).rejects.toThrow('Timed out waiting for Gateway context activation acceptance');

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it('preserves pending waits across a reconnectable close', async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const rawSocket = {
      addEventListener: vi.fn(
        (type: string, listener: (event: Record<string, unknown>) => void) => {
          listeners.set(type, listener);
        }
      ),
      close: vi.fn(),
      send: vi.fn(),
    };
    const broker = new ActivationAcceptanceBroker(100);
    const factory = createActivationObservingWebSocketFactory(
      broker,
      vi.fn(() => rawSocket)
    );
    const socket = factory('wss://example.test', []);
    socket.addEventListener('close', vi.fn());
    const accepted = broker.waitForAcceptance(EXPECTATION);

    listeners.get('close')?.({ code: 1006, reason: 'network lost' });
    broker.observe(acceptedFrame());

    await expect(accepted).resolves.toBeUndefined();
  });

  it('rejects pending waits on a terminal socket close', async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const rawSocket = {
      addEventListener: vi.fn(
        (type: string, listener: (event: Record<string, unknown>) => void) => {
          listeners.set(type, listener);
        }
      ),
      close: vi.fn(),
      send: vi.fn(),
    };
    const broker = new ActivationAcceptanceBroker(100);
    const factory = createActivationObservingWebSocketFactory(
      broker,
      vi.fn(() => rawSocket)
    );
    const socket = factory('wss://example.test', []);
    socket.addEventListener('close', vi.fn());
    const accepted = broker.waitForAcceptance(EXPECTATION);

    listeners.get('close')?.({ code: 4401, reason: 'unauthorized' });

    await expect(accepted).rejects.toThrow(
      'Gateway connection closed before context activation acceptance'
    );
  });
});
