import { resolve } from 'node:path';

import type { ContextPackHydrationResult } from './contextPackHydration.js';

const MAX_RUNTIME_SESSIONS = 256;
const runtimeSessions = new Map<string, ContextPackHydrationResult>();

function key(projectDir: string, sessionId: string): string {
  return `${resolve(projectDir)}\0${sessionId.trim()}`;
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
  return runtimeSessions.get(key(projectDir, sessionId));
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
  runtimeSessions.delete(key(projectDir, sessionId));
}
