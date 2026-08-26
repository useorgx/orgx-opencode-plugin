import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export type Env = Record<string, string | undefined>;

export const MAX_SESSION_WORK_CONTEXT_BYTES = 4 * 1024;
export const MAX_WIZARD_OUTPUT_BYTES = 16 * 1024;

const DEFAULT_TIMEOUT_MS = 3_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 10_000;
const SOURCE_CLIENT = 'opencode';
const ACK_VERSION = 'orgx-session-work-context-ack/v1';
const ACTIVATION_VERSION = 'orgx-session-work-context-activation/v2';
const WIZARD_ENV_ALLOWLIST = new Set([
  'APPDATA',
  'CI',
  'ComSpec',
  'DO_NOT_TRACK',
  'DSH_HOME',
  'FORCE_COLOR',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NO_COLOR',
  'ORGX_TELEMETRY_DISABLED',
  'ORGX_WIZARD_CONFIG_HOME',
  'ORGX_WIZARD_DISABLE_KEYTAR',
  'ORGX_WIZARD_HOOK_OUTBOX',
  'ORGX_WIZARD_HOOK_OUTBOX_MAX_BYTES',
  'ORGX_WIZARD_HOOK_SPOOL',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

export type SessionContextActivation = {
  activated: boolean;
  reason:
    | 'wizard_activated'
    | 'wizard_rejected'
    | 'wizard_unavailable'
    | 'wizard_timeout'
    | 'wizard_unverified'
    | 'wizard_cwd_mismatch'
    | 'wizard_output_too_large'
    | 'context_refresh_failed'
    | 'context_invalid'
    | 'not_returned';
  pendingPath?: string;
  priorActivationCleared?: boolean;
  clearReason?: string;
};

export type SessionContextClearance = {
  cleared: boolean;
  reason:
    | 'wizard_cleared'
    | 'wizard_already_clear'
    | 'wizard_rejected'
    | 'wizard_unavailable'
    | 'wizard_timeout'
    | 'wizard_unverified'
    | 'wizard_cwd_mismatch'
    | 'wizard_output_too_large'
    | 'project_directory_unavailable';
};

type SpawnedChild = {
  stdin?: {
    end: (value: string) => void;
    once?: (event: 'error', listener: () => void) => unknown;
  } | null;
  stdout?: {
    on?: (event: 'data', listener: (chunk: Uint8Array | string) => void) => unknown;
  } | null;
  once?: {
    (event: 'error', listener: () => void): unknown;
    (event: 'close', listener: (code: number | null) => void): unknown;
  };
  kill?: () => unknown;
};

export type SpawnLike = (
  command: string,
  args: string[],
  options: {
    env: Env;
    stdio: ['pipe', 'pipe', 'ignore'];
    windowsHide: true;
  }
) => SpawnedChild;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizedSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && byteLength(normalized) <= 512 ? normalized : null;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== undefined)
      .map((entry) => canonicalJsonValue(entry));
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = canonicalJsonValue(value[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalSessionWorkContextJson(context: unknown): string {
  const canonical = canonicalJsonValue(context);
  if (canonical === undefined) throw new TypeError('context is undefined');
  return JSON.stringify(canonical);
}

export function sessionWorkContextSha256(context: unknown): string {
  return canonicalJsonSha256(context);
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalSessionWorkContextJson(value))
    .digest('hex');
}

function boundedTimeout(value: string | undefined): number {
  const configured = Number(value);
  return Number.isFinite(configured) &&
    configured >= MIN_TIMEOUT_MS &&
    configured <= MAX_TIMEOUT_MS
    ? Math.round(configured)
    : DEFAULT_TIMEOUT_MS;
}

export function credentialFreeWizardEnvironment(env: Env): Env {
  const childEnv: Env = {};
  for (const name of WIZARD_ENV_ALLOWLIST) {
    if (typeof env[name] === 'string') childEnv[name] = env[name];
  }
  return childEnv;
}

function parseActivationAcknowledgement(
  stdout: string,
  projectDir: string,
  sessionId: string,
  contextSha256: string
): SessionContextActivation {
  try {
    const value: unknown = JSON.parse(stdout);
    if (
      !isRecord(value) ||
      value.ackVersion !== ACK_VERSION ||
      value.activationVersion !== ACTIVATION_VERSION ||
      value.ready !== true ||
      value.state !== 'ready' ||
      value.sourceClient !== SOURCE_CLIENT ||
      value.sessionId !== sessionId ||
      value.contextSha256 !== contextSha256
    ) {
      return { activated: false, reason: 'wizard_unverified' };
    }
    if (
      typeof value.cwd !== 'string' ||
      !isAbsolute(value.cwd) ||
      value.cwd !== projectDir
    ) {
      return { activated: false, reason: 'wizard_cwd_mismatch' };
    }
    return { activated: true, reason: 'wizard_activated' };
  } catch {
    return { activated: false, reason: 'wizard_unverified' };
  }
}

function parseClearAcknowledgement(
  stdout: string,
  projectDir: string,
  sessionId: string
): SessionContextClearance {
  try {
    const value: unknown = JSON.parse(stdout);
    if (
      !isRecord(value) ||
      value.ackVersion !== ACK_VERSION ||
      value.ready !== false ||
      value.state !== 'missing' ||
      value.sourceClient !== SOURCE_CLIENT ||
      value.sessionId !== sessionId
    ) {
      return { cleared: false, reason: 'wizard_unverified' };
    }
    if (
      typeof value.cwd !== 'string' ||
      !isAbsolute(value.cwd) ||
      value.cwd !== projectDir
    ) {
      return { cleared: false, reason: 'wizard_cwd_mismatch' };
    }
    return {
      cleared: true,
      reason: value.cleared === true ? 'wizard_cleared' : 'wizard_already_clear',
    };
  } catch {
    return { cleared: false, reason: 'wizard_unverified' };
  }
}

function runWizardJsonCommand<T>({
  args,
  env,
  failure,
  input = '',
  parseSuccess,
  projectDir,
  spawnImpl,
}: {
  args: string[];
  env: Env;
  failure: (reason: SessionContextActivation['reason']) => T;
  input?: string;
  parseSuccess: (stdout: string, projectDir: string) => T;
  projectDir: string;
  spawnImpl: SpawnLike;
}): Promise<T> {
  return new Promise((resolveResult) => {
    let settled = false;
    let outputBytes = 0;
    const output: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: T) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };

    let child: SpawnedChild;
    try {
      child = spawnImpl('orgx-wizard', args, {
        env: credentialFreeWizardEnvironment(env),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      if (!child) throw new Error('wizard unavailable');
    } catch {
      finish(failure('wizard_unavailable'));
      return;
    }

    child.once?.('error', () => finish(failure('wizard_unavailable')));
    child.stdout?.on?.('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > MAX_WIZARD_OUTPUT_BYTES) {
        child.kill?.();
        finish(failure('wizard_output_too_large'));
        return;
      }
      output.push(buffer);
    });
    child.once?.('close', (code) => {
      if (code !== 0) {
        finish(failure('wizard_rejected'));
        return;
      }
      finish(parseSuccess(Buffer.concat(output).toString('utf8'), projectDir));
    });
    child.stdin?.once?.('error', () => finish(failure('wizard_unavailable')));
    if (!child.stdin) {
      finish(failure('wizard_unavailable'));
      return;
    }
    timer = setTimeout(() => {
      child.kill?.();
      finish(failure('wizard_timeout'));
    }, boundedTimeout(env.ORGX_SESSION_CONTEXT_ACTIVATION_TIMEOUT_MS));

    try {
      child.stdin.end(input);
    } catch {
      finish(failure('wizard_unavailable'));
    }
  });
}

export async function activateSessionWorkContext({
  context,
  projectDir,
  sessionId,
  env = process.env,
  spawnImpl = nodeSpawn as unknown as SpawnLike,
}: {
  context?: unknown;
  projectDir?: string;
  sessionId?: string;
  env?: Env;
  spawnImpl?: SpawnLike;
} = {}): Promise<SessionContextActivation> {
  const normalizedId = normalizedSessionId(sessionId);
  if (
    !isRecord(context) ||
    context.schema_version !== 'orgx-session-work-context/v1' ||
    !projectDir ||
    !isAbsolute(projectDir) ||
    !normalizedId
  ) {
    return { activated: false, reason: 'context_invalid' };
  }
  const contextJson = canonicalSessionWorkContextJson(context);
  if (byteLength(contextJson) > MAX_SESSION_WORK_CONTEXT_BYTES) {
    return { activated: false, reason: 'context_invalid' };
  }
  const normalizedProjectDir = resolve(projectDir);
  const contextSha256 = createHash('sha256').update(contextJson).digest('hex');
  return runWizardJsonCommand<SessionContextActivation>({
    args: [
      'sessions',
      'context',
      'set',
      '--file',
      '-',
      '--cwd',
      normalizedProjectDir,
      '--source-client',
      SOURCE_CLIENT,
      '--session-id',
      normalizedId,
      '--context-sha256',
      contextSha256,
      '--json',
    ],
    env,
    failure: (reason) => ({ activated: false, reason }),
    input: contextJson,
    parseSuccess: (stdout, cwd) =>
      parseActivationAcknowledgement(
        stdout,
        cwd,
        normalizedId,
        contextSha256
      ),
    projectDir: normalizedProjectDir,
    spawnImpl,
  });
}

export async function clearSessionWorkContext({
  projectDir,
  sessionId,
  env = process.env,
  spawnImpl = nodeSpawn as unknown as SpawnLike,
}: {
  projectDir?: string;
  sessionId?: string;
  env?: Env;
  spawnImpl?: SpawnLike;
} = {}): Promise<SessionContextClearance> {
  const normalizedId = normalizedSessionId(sessionId);
  if (!projectDir || !isAbsolute(projectDir) || !normalizedId) {
    return { cleared: false, reason: 'project_directory_unavailable' };
  }
  const normalizedProjectDir = resolve(projectDir);
  return runWizardJsonCommand<SessionContextClearance>({
    args: [
      'sessions',
      'context',
      'clear',
      '--cwd',
      normalizedProjectDir,
      '--source-client',
      SOURCE_CLIENT,
      '--session-id',
      normalizedId,
      '--json',
    ],
    env,
    failure: (reason) => ({
      cleared: false,
      reason: reason as SessionContextClearance['reason'],
    }),
    parseSuccess: (stdout, cwd) =>
      parseClearAcknowledgement(stdout, cwd, normalizedId),
    projectDir: normalizedProjectDir,
    spawnImpl,
  });
}
