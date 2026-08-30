import {
  MAX_ADDITIONAL_CONTEXT_BYTES,
  type PrivateSessionContextClearance,
  type SessionContextClearance,
} from './contextPackHydration.js';
import { normalizeAbsoluteHostPath } from './hostPath.js';

type Env = Record<string, string | undefined>;
type Logger = Pick<Console, 'warn'>;
type Capture = (
  nativeEvent: string,
  payload: unknown
) => Promise<Record<string, unknown> | undefined>;
type ClearSessionWorkContext = (input: {
  env?: Env;
  projectDir?: string;
  sessionId?: string;
}) => Promise<SessionContextClearance>;
type ClearPrivateSessionContext = (input: {
  env?: Env;
  projectDir?: string;
  sessionId?: string;
}) => Promise<PrivateSessionContextClearance>;
type ExceptionStage =
  | 'session_context_clear'
  | 'private_session_context_clear';

export function nativeSessionId(value: unknown): string | undefined {
  const root = record(value);
  const properties = record(root.properties);
  const info = record(properties.info);
  for (const candidate of [
    root.sessionID,
    root.session_id,
    properties.sessionID,
    properties.session_id,
    info.sessionID,
    info.session_id,
    info.id,
  ]) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

export function isSuccessfulAssistantCompletion(value: unknown): boolean {
  const root = record(value);
  if (root.type !== 'message.updated') return false;
  const info = record(record(root.properties).info);
  const completed = record(info.time).completed;
  return (
    info.role === 'assistant' &&
    typeof completed === 'number' &&
    Number.isFinite(completed) &&
    info.error == null
  );
}

export function isRunEndConsumptionPersisted(value: unknown): boolean {
  const root = record(value);
  return (
    root.work_context_consumed === true ||
    (root.queued === true && root.state_persisted === true)
  );
}

export function sessionStartAdditionalContext(
  value: unknown
): string | undefined {
  const root = record(value);
  const hookOutput = record(root.hook_output);
  const hookSpecificOutput = record(hookOutput.hookSpecificOutput);
  const additionalContext = hookSpecificOutput.additionalContext;
  return hookOutput.continue === true &&
    hookOutput.suppressOutput === true &&
    hookSpecificOutput.hookEventName === 'SessionStart' &&
    typeof additionalContext === 'string' &&
    additionalContext.length > 0 &&
    Buffer.byteLength(additionalContext, 'utf8') <= MAX_ADDITIONAL_CONTEXT_BYTES
    ? additionalContext
    : undefined;
}

export function appendAdditionalContext(
  message: { system?: string },
  additionalContext: unknown
): void {
  if (
    typeof additionalContext !== 'string' ||
    additionalContext.length === 0 ||
    Buffer.byteLength(additionalContext, 'utf8') > MAX_ADDITIONAL_CONTEXT_BYTES
  ) {
    return;
  }
  const existing = typeof message.system === 'string' ? message.system : '';
  if (existing.includes(additionalContext)) return;
  message.system = existing
    ? `${existing}\n\n${additionalContext}`
    : additionalContext;
}

export function contextHydrationKey(
  projectDir: string,
  sessionId: string
): string | null {
  const normalizedProjectDir = normalizeAbsoluteHostPath(projectDir);
  return normalizedProjectDir
    ? `${normalizedProjectDir}\0${sessionId}`
    : null;
}

async function clearExactContext(
  clearContext: ClearSessionWorkContext,
  input: { env: Env; projectDir: string; sessionId: string },
  onException: (error: unknown, stage: ExceptionStage) => void
): Promise<SessionContextClearance> {
  return clearContext(input).catch((error) => {
    onException(error, 'session_context_clear');
    return { cleared: false, reason: 'wizard_unavailable' };
  });
}

async function clearPrivateContext(
  clearPrivate: ClearPrivateSessionContext,
  input: { env: Env; projectDir: string; sessionId: string },
  onException: (error: unknown, stage: ExceptionStage) => void
): Promise<PrivateSessionContextClearance> {
  return clearPrivate(input).catch((error) => {
    onException(error, 'private_session_context_clear');
    return {
      cleared: false,
      reason: 'private_state_clear_failed',
      removedFiles: 0,
    };
  });
}

export async function finalizeSessionContext({
  capture,
  clearContext,
  clearPrivate,
  env,
  event,
  logger,
  mode,
  onException,
  projectDir,
  sessionId,
}: {
  capture: Capture;
  clearContext: ClearSessionWorkContext;
  clearPrivate: ClearPrivateSessionContext;
  env: Env;
  event: unknown;
  logger: Logger;
  mode: 'gateway_abandoned' | 'interactive_abandoned' | 'used';
  onException: (error: unknown, stage: ExceptionStage) => void;
  projectDir: string;
  sessionId: string;
}): Promise<void> {
  const input = { env, projectDir, sessionId };

  if (mode === 'gateway_abandoned') {
    const clearance = await clearExactContext(
      clearContext,
      input,
      onException
    );
    if (!clearance.cleared) {
      logger.warn(
        `[orgx-opencode-plugin] Gateway session context clear unverified: ${clearance.reason}`
      );
      return;
    }
    const privateClearance = await clearPrivateContext(
      clearPrivate,
      input,
      onException
    );
    if (!privateClearance.cleared) {
      logger.warn(
        `[orgx-opencode-plugin] private session context clear unverified: ${privateClearance.reason}`
      );
    }
    await capture('session.abandoned', event);
    return;
  }

  if (mode === 'interactive_abandoned') {
    const release = await capture('session.abandoned', event);
    if (
      release?.activation_release_state !== 'released' &&
      release?.activation_release_state !== 'absent'
    ) {
      logger.warn(
        '[orgx-opencode-plugin] unused session context release unverified; exact owner state was preserved'
      );
      return;
    }
    const privateClearance = await clearPrivateContext(
      clearPrivate,
      input,
      onException
    );
    if (!privateClearance.cleared) {
      logger.warn(
        `[orgx-opencode-plugin] private session context clear unverified: ${privateClearance.reason}`
      );
    }
    return;
  }

  const [clearance, privateClearance] = await Promise.all([
    clearExactContext(clearContext, input, onException),
    clearPrivateContext(clearPrivate, input, onException),
  ]);
  if (!clearance.cleared) {
    logger.warn(
      `[orgx-opencode-plugin] session context clear unverified: ${clearance.reason}`
    );
  }
  if (!privateClearance.cleared) {
    logger.warn(
      `[orgx-opencode-plugin] private session context clear unverified: ${privateClearance.reason}`
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
