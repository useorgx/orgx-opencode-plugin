import {
  PeerClient,
  type Driver,
  type WebSocketEvent,
  type WebSocketLike,
} from '@useorgx/orgx-gateway-sdk';
import { describe, expect, it, vi } from 'vitest';

import { OpenCodeDriver } from './OpenCodeDriver.js';

const DIGEST = `sha256:${'a'.repeat(64)}` as const;

class TestSocket implements WebSocketLike {
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<
    'open' | 'close' | 'error' | 'message',
    Array<(event: WebSocketEvent) => void>
  >();

  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: WebSocketEvent) => void
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {}

  constructor(private readonly rejectKind?: string) {}

  send(data: string): void {
    const message = JSON.parse(data) as { kind?: string };
    if (message.kind === this.rejectKind) {
      throw new Error(`test socket rejected ${this.rejectKind}`);
    }
    this.sent.push(message);
  }

  emit(type: 'open' | 'close' | 'error' | 'message', event: WebSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function completedDriver(providerId: string | null): Driver {
  return {
    id: 'opencode',
    detect: vi.fn(async () => ({ installed: true, authenticated: true })),
    probe: vi.fn(async () => ({
      subscription_active: true,
      session_alive: true,
    })),
    cancel: vi.fn(async () => undefined),
    async *dispatch(_task, context) {
      yield {
        kind: 'task.completed',
        run_id: context.run_id,
        outcome_kind: 'awaiting_review',
        started_at: '2026-08-29T13:00:00.000Z',
        completed_at: '2026-08-29T13:00:01.000Z',
        tokens_used: 100,
        provider: providerId === null ? 'other' : 'openai',
        provider_id: providerId,
        observed_provider_id: providerId ?? 'anthropic',
        source_sub_type: 'user_managed',
        source_driver: 'opencode',
        cost_estimate_cents: 0,
      };
    },
  };
}

function emitV1Dispatch(socket: TestSocket, runId: string): void {
  socket.emit('message', {
    data: JSON.stringify({
      kind: 'task.dispatch',
      run_id: runId,
      idempotency_key: `key-${runId}`,
      timeout_seconds: 60,
      task: { title: 'echo provider lease', driver: 'opencode' },
    }),
  });
}

describe('Gateway SDK protocol boundary', () => {
  it.each([
    ['openai', 'openai'],
    [null, 'other'],
  ] as const)(
    'preserves the exact provider_id lease %s on the WebSocket terminal',
    async (providerId, provider) => {
      const socket = new TestSocket();
      const peer = new PeerClient({
        baseUrl: 'wss://useorgx.test',
        apiKey: 'oxk_test_only',
        workspaceId: 'workspace-1',
        pluginId: 'orgx-opencode-plugin',
        protocolVersion: 1,
        drivers: [completedDriver(providerId)],
        reconnect: false,
        webSocketFactory: () => socket,
      });

      peer.connect();
      socket.emit('open', {});
      emitV1Dispatch(socket, `run-${provider}`);

      await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
      expect(socket.sent[0]).toMatchObject({
        kind: 'task.completed',
        provider,
        provider_id: providerId,
        observed_provider_id: providerId ?? 'anthropic',
        source_sub_type: 'user_managed',
        source_driver: 'opencode',
      });
      peer.disconnect();
    }
  );

  it('preserves provider_id in the HTTP recovery receipt when the terminal socket send fails', async () => {
    const socket = new TestSocket('task.completed');
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const peer = new PeerClient({
      baseUrl: 'wss://useorgx.test',
      apiKey: 'oxk_test_only',
      workspaceId: 'workspace-1',
      pluginId: 'orgx-opencode-plugin',
      protocolVersion: 1,
      drivers: [completedDriver(null)],
      reconnect: false,
      webSocketFactory: () => socket,
      fetch: vi.fn(async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? '{}')),
        });
        return new Response('{}', { status: 200 });
      }),
    });

    peer.connect();
    socket.emit('open', {});
    emitV1Dispatch(socket, 'run-recovery');

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      url: 'https://useorgx.test/api/v1/runs/run-recovery/receipt',
      body: expect.objectContaining({
        provider: 'other',
        provider_id: null,
        observed_provider_id: 'anthropic',
        source_sub_type: 'user_managed',
        source_driver: 'opencode',
      }),
    });
    peer.disconnect();
  });

  it('fails protocol v2 before native session creation instead of emitting a mismatched terminal', async () => {
    const socket = new TestSocket();
    const createClient = vi.fn(() => {
      throw new Error('native OpenCode must not start for unsupported v2');
    });
    const driver = new OpenCodeDriver({
      createClient: createClient as never,
      defaultDirectory: '/work/repo',
      openCodeServerUrl: 'http://127.0.0.1:4096',
      workspaceId: 'workspace-1',
      workGraphOutboxPath: false,
    });
    const peer = new PeerClient({
      baseUrl: 'wss://useorgx.test',
      apiKey: 'oxk_test_only',
      workspaceId: 'workspace-1',
      pluginId: 'orgx-opencode-plugin',
      protocolVersion: 1,
      drivers: [driver],
      reconnect: false,
      webSocketFactory: () => socket,
    });

    peer.connect();
    socket.emit('open', {});
    socket.emit('message', {
      data: JSON.stringify({
        kind: 'task.dispatch',
        protocol_version: 2,
        run_id: 'run-v2',
        idempotency_key: 'key-v2',
        timeout_seconds: 60,
        task: {
          title: 'unsupported proof-bearing dispatch',
          driver: 'opencode',
        },
        execution_envelope: {
          schemaVersion: '1.0.0',
          producer: {
            actor: { type: 'service', id: 'orgx-gateway' },
            service: 'orgx-gateway',
            serviceVersion: 'test',
          },
          id: 'envelope-v2',
          runId: 'run-v2',
          attemptId: 'attempt-v2',
          idempotencyKey: 'key-v2',
          workRef: {
            workspaceId: 'workspace-1',
            initiativeId: 'initiative-1',
          },
          missionId: 'mission-1',
          missionContractDigest: DIGEST,
          nodeId: 'node-1',
          contextManifestDigest: DIGEST,
          capabilityLeaseId: 'lease-1',
          capabilityLeaseDigest: DIGEST,
          runtimeProfileDigest: DIGEST,
          qualityBarVersionId: 'quality-1',
          skillVersionDigests: [],
          toolManifestDigests: [],
          budget: {
            modelCostMicros: '0',
            toolCostMicros: '0',
            humanMinutes: 0,
          },
          requestedAt: '2026-08-26T16:00:00.000Z',
          digest: DIGEST,
        },
      }),
    });

    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent).toEqual([
      {
        kind: 'task.failed',
        run_id: 'run-v2',
        reason:
          'OpenCode proof-bearing Gateway protocol v2 finalization is not supported',
        recoverable: false,
      },
    ]);
    expect(createClient).not.toHaveBeenCalled();
    peer.disconnect();
  });
});
