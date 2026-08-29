import type { ContextPackHydrationResult } from './contextPackHydration.js';
import { normalizeAbsoluteHostPath } from './hostPath.js';

const MAX_RUNTIME_SESSIONS = 256;
const runtimeSessions = new Map<string, ContextPackHydrationResult>();

function key(projectDir: string, sessionId: string): string | null {
  const normalizedProjectDir = normalizeAbsoluteHostPath(projectDir);
  const normalizedSessionId = sessionId.trim();
  return normalizedProjectDir && normalizedSessionId
    ? `${normalizedProjectDir}\0${normalizedSessionId}`
    : null;
}

/**
 * Bridge a driver-resolved runtime scope into native plugin hooks in the same
 * process. This takes precedence over ambient process-scope hydration.
 */
export function publishRuntimeSessionHydration(
  projectDir: string,
  sessionId: string,
  result: ContextPackHydrationResult
): void {
  const sessionKey = key(projectDir, sessionId);
  if (!sessionKey) return;
  runtimeSessions.delete(sessionKey);
  runtimeSessions.set(sessionKey, result);
  while (runtimeSessions.size > MAX_RUNTIME_SESSIONS) {
    const oldest = runtimeSessions.keys().next().value;
    if (typeof oldest !== 'string') break;
    runtimeSessions.delete(oldest);
  }
}

export function readRuntimeSessionHydration(
  projectDir: string,
  sessionId: string
): ContextPackHydrationResult | undefined {
  const sessionKey = key(projectDir, sessionId);
  return sessionKey ? runtimeSessions.get(sessionKey) : undefined;
}

/** Prevent a cached ambient pack from regaining authority after failure. */
export function blockRuntimeSessionHydration(
  projectDir: string,
  sessionId: string
): void {
  publishRuntimeSessionHydration(projectDir, sessionId, {
    ok: false,
    skipped: 'context_pack_hydration_failed',
  });
}

export function clearRuntimeSessionHydration(
  projectDir: string,
  sessionId: string
): void {
  const sessionKey = key(projectDir, sessionId);
  if (sessionKey) runtimeSessions.delete(sessionKey);
}
