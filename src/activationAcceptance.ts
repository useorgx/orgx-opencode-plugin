import type {
  PeerClientConfig,
  WebSocketEvent,
  WebSocketLike,
} from '@useorgx/orgx-gateway-sdk';

const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 5_000;
const MAX_ACCEPTANCE_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TERMINAL_CLOSE_CODES = new Set([1000, 4000, 4001, 4003, 4401, 4403]);

export type ActivationAcceptanceExpectation = {
  runId: string;
  contextSha256: `sha256:${string}`;
  activationSha256: `sha256:${string}`;
  nativeSessionId: string;
};

type PendingAcceptance = {
  expectation: ActivationAcceptanceExpectation;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Correlates the Gateway's durable activation acceptance with the dispatch
 * that emitted the corresponding task.started acknowledgement.
 */
export class ActivationAcceptanceBroker {
  private readonly pending = new Map<string, PendingAcceptance>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = DEFAULT_ACCEPTANCE_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
      throw new Error('Gateway activation acceptance timeout is invalid');
    }
    this.timeoutMs = Math.min(Math.round(timeoutMs), MAX_ACCEPTANCE_TIMEOUT_MS);
  }

  waitForAcceptance(
    expectation: ActivationAcceptanceExpectation
  ): Promise<void> {
    validateExpectation(expectation);
    if (this.pending.has(expectation.runId)) {
      return Promise.reject(
        new Error('Duplicate Gateway activation acceptance wait')
      );
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(expectation.runId);
        reject(
          new Error('Timed out waiting for Gateway context activation acceptance')
        );
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(expectation.runId, {
        expectation,
        resolve,
        reject,
        timer,
      });
    });
  }

  observe(rawMessage: unknown): boolean {
    const message = parseMessage(rawMessage);
    if (!message) return false;
    const kind = message.kind;
    if (
      kind !== 'task.activation.accepted' &&
      kind !== 'task.activation.rejected'
    ) {
      return false;
    }
    const runId = typeof message.run_id === 'string' ? message.run_id : '';
    const pending = this.pending.get(runId);
    if (!pending) return true;

    if (kind === 'task.activation.rejected') {
      this.reject(runId, 'Gateway rejected OrgX context activation');
      return true;
    }

    if (
      message.schema_version !==
        'orgx-gateway-session-context-activation-accepted/v1' ||
      message.source_client !== 'opencode' ||
      typeof message.accepted_at !== 'string' ||
      Buffer.byteLength(message.accepted_at, 'utf8') > 64 ||
      !Number.isFinite(Date.parse(message.accepted_at)) ||
      message.context_sha256 !== pending.expectation.contextSha256 ||
      message.activation_sha256 !== pending.expectation.activationSha256 ||
      message.native_session_id !== pending.expectation.nativeSessionId
    ) {
      this.reject(runId, 'Gateway context activation acceptance mismatch');
      return true;
    }

    clearTimeout(pending.timer);
    this.pending.delete(runId);
    pending.resolve();
    return true;
  }

  rejectRun(runId: string, reason: string): void {
    this.reject(runId, reason);
  }

  rejectAll(reason = 'Gateway connection closed before context activation acceptance'):
    void {
    for (const runId of [...this.pending.keys()]) this.reject(runId, reason);
  }

  private reject(runId: string, reason: string): void {
    const pending = this.pending.get(runId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(runId);
    pending.reject(new Error(reason));
  }
}

export function createActivationObservingWebSocketFactory(
  broker: ActivationAcceptanceBroker,
  baseFactory: NonNullable<PeerClientConfig['webSocketFactory']> =
    defaultWebSocketFactory
): NonNullable<PeerClientConfig['webSocketFactory']> {
  return (url, protocols) => {
    const socket = baseFactory(url, protocols);
    return {
      addEventListener(type, listener) {
        socket.addEventListener(type, (event) => {
          if (type === 'message') broker.observe(event.data);
          if (
            type === 'close' &&
            TERMINAL_CLOSE_CODES.has(event.code ?? 1006)
          ) {
            broker.rejectAll(
              'Gateway connection closed before context activation acceptance'
            );
          }
          listener(event);
        });
      },
      close(code, reason) {
        socket.close(code, reason);
      },
      send(data) {
        socket.send(data);
      },
    };
  };
}

function defaultWebSocketFactory(url: string, protocols: string[]): WebSocketLike {
  const socket = new WebSocket(url, protocols);
  return {
    addEventListener(type, listener) {
      socket.addEventListener(type, (event) => {
        const value = event as unknown as WebSocketEvent;
        listener({
          ...(typeof value.code === 'number' ? { code: value.code } : {}),
          ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
          ...('data' in value ? { data: value.data } : {}),
        });
      });
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    send(data) {
      socket.send(data);
    },
  };
}

function validateExpectation(expectation: ActivationAcceptanceExpectation): void {
  if (
    !boundedId(expectation.runId) ||
    !boundedId(expectation.nativeSessionId) ||
    !SHA256_PATTERN.test(expectation.contextSha256) ||
    !SHA256_PATTERN.test(expectation.activationSha256)
  ) {
    throw new Error('Gateway activation acceptance expectation is invalid');
  }
}

function boundedId(value: string): boolean {
  return Boolean(value.trim()) && Buffer.byteLength(value, 'utf8') <= 512;
}

function parseMessage(value: unknown): Record<string, unknown> | null {
  try {
    const parsed =
      typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
