import {
  PeerClient,
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

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  emit(type: 'open' | 'close' | 'error' | 'message', event: WebSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('Gateway SDK protocol boundary', () => {
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
