/**
 * Bounded, fail-open organizational-context hydration for OpenCode.
 *
 * Network authority comes only from the launching environment. A successful
 * response is retained as an inspectable pack, while receipt-ready session
 * authority is activated only after the Wizard returns an exact-cwd JSON ack.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  MAX_SESSION_WORK_CONTEXT_BYTES,
  activateSessionWorkContext,
  canonicalJsonSha256,
  canonicalSessionWorkContextJson,
  clearSessionWorkContext,
  type Env,
  type SessionContextActivation,
  type SessionContextClearance,
  type SpawnLike,
} from './wizardContextBridge.js';
import { normalizeAbsoluteHostPath } from './hostPath.js';

export {
  MAX_SESSION_WORK_CONTEXT_BYTES,
  MAX_WIZARD_OUTPUT_BYTES,
  activateSessionWorkContext,
  canonicalJsonSha256,
  canonicalSessionWorkContextJson,
  clearSessionWorkContext,
  sessionWorkContextSha256,
  type SessionContextActivation,
  type SessionContextClearance,
  type SpawnLike,
} from './wizardContextBridge.js';

export const CONTEXT_PACK_FILENAME = 'orgx-context-pack.json';
export const PENDING_CONTEXT_FILENAME =
  'orgx-session-work-context.activation-pending.json';
export const OPENCODE_CONTEXT_STATE_DIRECTORY = 'opencode-contexts';
export const MAX_CONTEXT_PACK_RESPONSE_BYTES = 128 * 1024;
export const MAX_ADDITIONAL_CONTEXT_BYTES = 8 * 1024;

const DEFAULT_BASE_URL = 'https://useorgx.com';
const DEFAULT_TIMEOUT_MS = 3_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 10_000;

const SCOPE_CONFIG = [
  { type: 'workspace', requestField: 'workspace_id', env: 'ORGX_WORKSPACE_ID' },
  {
    type: 'initiative',
    requestField: 'initiative_id',
    env: 'ORGX_INITIATIVE_ID',
  },
  {
    type: 'workstream',
    requestField: 'workstream_id',
    env: 'ORGX_WORKSTREAM_ID',
  },
  { type: 'task', requestField: 'task_id', env: 'ORGX_TASK_ID' },
] as const;
const ANCHOR_PRIORITY = ['task', 'workstream', 'initiative', 'workspace'] as const;

type AnchorType = (typeof SCOPE_CONFIG)[number]['type'];
type ScopeRequestField = (typeof SCOPE_CONFIG)[number]['requestField'];

export interface ContextPackConfig {
  apiKey: string;
  baseUrl: string;
  scope: Partial<Record<ScopeRequestField, string>>;
  anchor: { type: AnchorType; id: string; requestField: ScopeRequestField };
}

export type ContextPackHydrationResult = {
  ok: boolean;
  skipped?:
    | 'project_directory_unavailable'
    | 'session_id_unavailable'
    | 'context_pack_unconfigured'
    | 'context_pack_request_failed'
    | 'context_pack_response_too_large'
    | 'context_pack_response_invalid'
    | 'context_pack_hydration_failed';
  reason?: 'timeout' | 'network_error';
  status?: number;
  contextPackPath?: string;
  sessionContext?: SessionContextActivation;
  additionalContext?: string;
};

export type PrivateSessionContextClearance = {
  cleared: boolean;
  reason:
    | 'private_state_cleared' | 'private_state_absent'
    | 'project_directory_unavailable' | 'session_id_unavailable'
    | 'private_state_unsafe'
    | 'private_state_clear_failed';
  removedFiles: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    hostname.toLowerCase()
  );
}

/** Reject credentials, suffixes, non-HTTPS remote origins, and path redirects. */
export function resolveSafeBaseUrl(value: string | undefined): string | null {
  const candidate = pickString(value) ?? DEFAULT_BASE_URL;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    ) {
      return null;
    }
    if (
      parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function resolveContextPackConfig(env: Env): ContextPackConfig | null {
  const apiKey = pickString(env.ORGX_API_KEY);
  const baseUrl = resolveSafeBaseUrl(env.ORGX_BASE_URL);
  const scope: Partial<Record<ScopeRequestField, string>> = {};
  for (const field of SCOPE_CONFIG) {
    const id = pickString(env[field.env]);
    if (id) scope[field.requestField] = id;
  }
  const anchorType = ANCHOR_PRIORITY.find((type) => {
    const field = SCOPE_CONFIG.find((candidate) => candidate.type === type);
    return field ? Boolean(scope[field.requestField]) : false;
  });
  const anchorField = SCOPE_CONFIG.find((field) => field.type === anchorType);
  const anchorId = anchorField ? scope[anchorField.requestField] : undefined;
  if (!apiKey || !baseUrl || !anchorField || !anchorId) return null;
  return {
    apiKey,
    baseUrl,
    scope,
    anchor: {
      type: anchorField.type,
      id: anchorId,
      requestField: anchorField.requestField,
    },
  };
}

export function buildContextPackRequest(config: ContextPackConfig): {
  url: string;
  init: RequestInit;
} {
  return {
    url: `${config.baseUrl}/api/v1/context-pack`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(config.scope),
      redirect: 'error',
    },
  };
}

function boundedTimeout(value: string | undefined): number {
  const configured = Number(value);
  return Number.isFinite(configured) &&
    configured >= MIN_TIMEOUT_MS &&
    configured <= MAX_TIMEOUT_MS
    ? Math.round(configured)
    : DEFAULT_TIMEOUT_MS;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  const contentLength = Number(response.headers?.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return byteLength(text) <= maxBytes ? text : null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function writePrivateJson(
  state: PrivateContextState,
  filename: string,
  value: unknown,
  maxBytes = MAX_CONTEXT_PACK_RESPONSE_BYTES
): Promise<string> {
  const serialized = JSON.stringify(value);
  if (byteLength(serialized) > maxBytes) throw new Error('bounded_json_too_large');
  const stateDir = await privateStateDirectory(state, true);
  if (!stateDir) throw new Error('private_state_directory_unavailable');
  const path = join(stateDir, filename);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    await writeFile(temporaryPath, serialized, { flag: 'wx', mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    committed = true;
    await chmod(path, 0o600);
    return path;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (committed) await unlink(path).catch(() => undefined);
    throw error;
  }
}

type PrivateContextState = {
  env: Env;
  projectDir: string;
  sessionId: string;
  stateRoot?: string;
};

function defaultContextStateRoot(env: Env): string | null {
  const configuredWizardHome = pickString(env.ORGX_WIZARD_CONFIG_HOME);
  if (configuredWizardHome) {
    return isAbsolute(configuredWizardHome)
      ? join(resolve(configuredWizardHome), OPENCODE_CONTEXT_STATE_DIRECTORY)
      : null;
  }
  const configuredXdgHome = pickString(env.XDG_CONFIG_HOME);
  const configHome =
    configuredXdgHome && isAbsolute(configuredXdgHome)
      ? resolve(configuredXdgHome)
      : join(homedir(), '.config');
  return join(configHome, 'useorgx', 'wizard', OPENCODE_CONTEXT_STATE_DIRECTORY);
}

/**
 * Return the owner-local state directory for one native OpenCode session.
 * The digest keeps cwd/session values out of filenames while preventing two
 * sessions in the same repository from sharing mutable hydration state.
 */
export function resolvePrivateContextStateDirectory({
  env = process.env,
  projectDir,
  sessionId,
  stateRoot,
}: {
  env?: Env;
  projectDir?: string;
  sessionId?: string;
  stateRoot?: string;
}): string | null {
  const normalizedSessionId = pickString(sessionId);
  const normalizedProjectDir = normalizeAbsoluteHostPath(projectDir);
  if (
    !normalizedProjectDir ||
    !normalizedSessionId ||
    byteLength(normalizedSessionId) > 512
  ) {
    return null;
  }
  const root = stateRoot
    ? isAbsolute(stateRoot)
      ? resolve(stateRoot)
      : null
    : defaultContextStateRoot(env);
  if (!root || dirname(root) === root) return null;
  const relativeToProject = relative(normalizedProjectDir, root);
  if (
    relativeToProject === '' ||
    (relativeToProject !== '..' &&
      !relativeToProject.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToProject))
  ) {
    return null;
  }
  const digest = createHash('sha256')
    .update(normalizedProjectDir)
    .update('\0')
    .update(normalizedSessionId)
    .digest('hex');
  return join(root, digest);
}

function isPathWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return (
    child === '' ||
    (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

async function projectedRealPath(path: string): Promise<string> {
  let cursor = path;
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function ensurePrivateDirectory(
  path: string,
  create: boolean,
  errorCode: string
): Promise<boolean> {
  if (create) {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  try {
    const state = await lstat(path);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error(errorCode);
    await chmod(path, 0o700);
    return true;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function privateStateDirectory(
  state: PrivateContextState,
  create: boolean
): Promise<string | null> {
  const project = await lstat(state.projectDir);
  if (!project.isDirectory() || project.isSymbolicLink()) {
    throw new Error('unsafe_project_directory');
  }
  const stateDir = resolvePrivateContextStateDirectory(state);
  if (!stateDir) throw new Error('private_state_directory_unavailable');
  const stateRoot = resolve(stateDir, '..');
  const realProjectDir = await realpath(state.projectDir);
  if (isPathWithin(realProjectDir, await projectedRealPath(stateRoot))) {
    throw new Error('private_state_inside_project');
  }
  if (!(await ensurePrivateDirectory(stateRoot, create, 'unsafe_private_state_root'))) {
    return null;
  }
  if (isPathWithin(realProjectDir, await realpath(stateRoot))) {
    throw new Error('private_state_inside_project');
  }
  if (
    !(await ensurePrivateDirectory(
      stateDir,
      create,
      'unsafe_private_state_directory'
    ))
  ) {
    return null;
  }
  return stateDir;
}

async function removePrivateContextFile(
  state: PrivateContextState,
  filename: string
): Promise<void> {
  const stateDir = await privateStateDirectory(state, false);
  if (!stateDir) return;
  await unlink(join(stateDir, filename)).catch(() => undefined);
}

async function removePendingContext(state: PrivateContextState): Promise<void> {
  await removePrivateContextFile(state, PENDING_CONTEXT_FILENAME);
}

async function resolveExactPrivateContextFile(
  stateDir: string,
  filename: typeof CONTEXT_PACK_FILENAME | typeof PENDING_CONTEXT_FILENAME
): Promise<string | null> {
  const candidate = resolve(stateDir, filename);
  if (dirname(candidate) !== stateDir || !isPathWithin(stateDir, candidate)) {
    throw new Error('unsafe_private_context_path');
  }
  try {
    const file = await lstat(candidate);
    if (!file.isFile() && !file.isSymbolicLink()) {
      throw new Error('unsafe_private_context_file');
    }
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function unlinkPrivateContextFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function privateContextClearFailureReason(
  error: unknown
): PrivateSessionContextClearance['reason'] {
  const message = error instanceof Error ? error.message : '';
  return /unsafe|unavailable|inside_project/.test(message)
    ? 'private_state_unsafe'
    : 'private_state_clear_failed';
}

// Recompute terminal paths from the validated project/session tuple so callers
// cannot select a filename or another session's persisted state.
export async function clearPrivateSessionContext({
  env = process.env,
  projectDir,
  sessionId,
  stateRoot,
}: {
  env?: Env;
  projectDir?: string;
  sessionId?: string;
  stateRoot?: string;
} = {}): Promise<PrivateSessionContextClearance> {
  const normalizedProjectDir = normalizeAbsoluteHostPath(projectDir);
  if (!normalizedProjectDir) {
    return { cleared: false, reason: 'project_directory_unavailable', removedFiles: 0 };
  }
  const normalizedSessionId = pickString(sessionId);
  if (!normalizedSessionId || byteLength(normalizedSessionId) > 512) {
    return { cleared: false, reason: 'session_id_unavailable', removedFiles: 0 };
  }
  const privateState: PrivateContextState = {
    env,
    projectDir: normalizedProjectDir,
    sessionId: normalizedSessionId,
    stateRoot,
  };
  try {
    const stateDir = await privateStateDirectory(privateState, false);
    if (!stateDir) {
      return { cleared: true, reason: 'private_state_absent', removedFiles: 0 };
    }
    const candidates = await Promise.all([
      resolveExactPrivateContextFile(stateDir, CONTEXT_PACK_FILENAME),
      resolveExactPrivateContextFile(stateDir, PENDING_CONTEXT_FILENAME),
    ]);
    const removals = await Promise.allSettled(
      candidates
        .filter((candidate): candidate is string => Boolean(candidate))
        .map(unlinkPrivateContextFile)
    );
    const removedFiles = removals.filter(
      (result) => result.status === 'fulfilled' && result.value
    ).length;
    const failure = removals.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      return {
        cleared: false,
        reason: privateContextClearFailureReason(failure.reason),
        removedFiles,
      };
    }
    return {
      cleared: true,
      reason:
        removedFiles > 0 ? 'private_state_cleared' : 'private_state_absent',
      removedFiles,
    };
  } catch (error) {
    return {
      cleared: false,
      reason: privateContextClearFailureReason(error),
      removedFiles: 0,
    };
  }
}

export async function persistPendingSessionWorkContext(
  state: PrivateContextState,
  context: Record<string, unknown>
): Promise<string> {
  return writePrivateJson(
    state,
    PENDING_CONTEXT_FILENAME,
    context,
    MAX_SESSION_WORK_CONTEXT_BYTES
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffix = '\n[OrgX context truncated; inspect owner-local OrgX state.]';
  const budget = maxBytes - byteLength(suffix);
  let text = '';
  for (const char of value) {
    if (byteLength(text + char) > budget) break;
    text += char;
  }
  return text + suffix;
}

function additionalContextFor(
  context: Record<string, unknown> | null,
  activation: SessionContextActivation
): string {
  if (!context) {
    const clearanceLine = activation.priorActivationCleared
      ? 'Any prior exact-directory Wizard activation was cleared.'
      : `Wizard could not verify removal of a prior activation (${activation.clearReason ?? 'unknown'}); do not rely on earlier session authority.`;
    return [
      'OrgX did not activate fresh receipt-ready session context.',
      'Refresh consequential state through OrgX before acting.',
      clearanceLine,
    ].join('\n');
  }
  const activationLine = activation.activated
    ? 'Wizard validated and activated this context for the exact current OpenCode session.'
    : `Wizard activation is pending (${activation.reason}); use this as briefing only, not as proof of authority.`;
  const clearanceLine = activation.activated
    ? null
    : activation.priorActivationCleared
      ? 'Any prior authority lease for this exact OpenCode session was cleared.'
      : `Wizard could not verify removal of a prior session lease (${activation.clearReason ?? 'unknown'}); do not rely on earlier authority.`;
  return truncateUtf8(
    [
      'OrgX session context (producer-asserted; accepted references retain their own provenance):',
      activationLine,
      ...(clearanceLine ? [clearanceLine] : []),
      'The full compiled pack is retained in owner-only OrgX local state for inspection.',
      JSON.stringify(context),
    ].join('\n'),
    MAX_ADDITIONAL_CONTEXT_BYTES
  );
}

async function clearDefinitiveContext({
  contextPackPath,
  env,
  projectDir,
  privateState,
  reason,
  spawnImpl,
}: {
  contextPackPath: string;
  env: Env;
  projectDir: string;
  privateState: PrivateContextState;
  reason: 'not_returned' | 'context_invalid';
  spawnImpl: SpawnLike;
}): Promise<ContextPackHydrationResult> {
  await removePendingContext(privateState);
  const clearance = await clearSessionWorkContext({
    projectDir,
    sessionId: privateState.sessionId,
    env,
    spawnImpl,
  });
  const sessionContext: SessionContextActivation = {
    activated: false,
    reason,
    priorActivationCleared: clearance.cleared,
    clearReason: clearance.reason,
  };
  return {
    ok: true,
    contextPackPath,
    sessionContext,
    additionalContext: additionalContextFor(null, sessionContext),
  };
}

async function clearUnverifiedContext({
  env,
  projectDir,
  privateState,
  result,
  spawnImpl,
}: {
  env: Env;
  projectDir: string;
  privateState: PrivateContextState;
  result: ContextPackHydrationResult;
  spawnImpl: SpawnLike;
}): Promise<ContextPackHydrationResult> {
  await Promise.all([
    removePendingContext(privateState),
    removePrivateContextFile(privateState, CONTEXT_PACK_FILENAME),
  ]).catch(() => undefined);
  const clearance = await clearSessionWorkContext({
    projectDir,
    sessionId: privateState.sessionId,
    env,
    spawnImpl,
  });
  const sessionContext: SessionContextActivation = {
    activated: false,
    reason: 'context_refresh_failed',
    priorActivationCleared: clearance.cleared,
    clearReason: clearance.reason,
  };
  return {
    ...result,
    sessionContext,
    additionalContext: additionalContextFor(null, sessionContext),
  };
}

export async function hydrateContextPack({
  disabled = false,
  env = process.env,
  projectDir,
  sessionId,
  stateRoot,
  fetchImpl = globalThis.fetch,
  spawnImpl = nodeSpawn as unknown as SpawnLike,
  now = new Date(),
}: {
  disabled?: boolean;
  env?: Env;
  projectDir?: string;
  sessionId?: string;
  stateRoot?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnLike;
  now?: Date;
} = {}): Promise<ContextPackHydrationResult> {
  const normalizedProjectDir = normalizeAbsoluteHostPath(projectDir);
  try {
    if (!normalizedProjectDir) {
      return { ok: true, skipped: 'project_directory_unavailable' };
    }
    if (!pickString(sessionId) || byteLength(pickString(sessionId)!) > 512) {
      return { ok: true, skipped: 'session_id_unavailable' };
    }
    const privateState: PrivateContextState = {
      env,
      projectDir: normalizedProjectDir,
      sessionId: pickString(sessionId)!,
      stateRoot,
    };
    const config = disabled ? null : resolveContextPackConfig(env);
    if (!config) {
      return clearUnverifiedContext({
        env,
        projectDir: normalizedProjectDir,
        privateState,
        result: { ok: true, skipped: 'context_pack_unconfigured' },
        spawnImpl,
      });
    }
    const { url, init } = buildContextPackRequest(config);
    const controller = new AbortController();
    const requestTimer = setTimeout(
      () => controller.abort(),
      boundedTimeout(env.ORGX_CONTEXT_PACK_TIMEOUT_MS)
    );
    let response: Response;
    let responseText: string | null;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        return clearUnverifiedContext({
          env,
          projectDir: normalizedProjectDir,
          privateState,
          result: {
            ok: true,
            skipped: 'context_pack_request_failed',
            status: response.status,
          },
          spawnImpl,
        });
      }
      responseText = await readBoundedResponseText(
        response,
        MAX_CONTEXT_PACK_RESPONSE_BYTES
      );
    } catch (error) {
      return clearUnverifiedContext({
        env,
        projectDir: normalizedProjectDir,
        privateState,
        result: {
          ok: true,
          skipped: 'context_pack_request_failed',
          reason:
            error instanceof Error && error.name === 'AbortError'
              ? 'timeout'
              : 'network_error',
        },
        spawnImpl,
      });
    } finally {
      clearTimeout(requestTimer);
    }
    if (responseText === null) {
      return clearUnverifiedContext({
        env,
        projectDir: normalizedProjectDir,
        privateState,
        result: { ok: true, skipped: 'context_pack_response_too_large' },
        spawnImpl,
      });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      return clearUnverifiedContext({
        env,
        projectDir: normalizedProjectDir,
        privateState,
        result: { ok: true, skipped: 'context_pack_response_invalid' },
        spawnImpl,
      });
    }
    const data =
      isRecord(payload) && payload.ok === true ? payload.data : undefined;
    if (!isRecord(data)) {
      return clearUnverifiedContext({
        env,
        projectDir: normalizedProjectDir,
        privateState,
        result: { ok: true, skipped: 'context_pack_response_invalid' },
        spawnImpl,
      });
    }

    const contextPackPath = await writePrivateJson(
      privateState,
      CONTEXT_PACK_FILENAME,
      { fetchedAt: now.toISOString(), data }
    );
    const context = data.sessionWorkContext;
    if (!isRecord(context)) {
      return clearDefinitiveContext({
        contextPackPath,
        env,
        projectDir: normalizedProjectDir,
        privateState,
        reason: 'not_returned',
        spawnImpl,
      });
    }
    if (
      context.schema_version !== 'orgx-session-work-context/v1' ||
      byteLength(JSON.stringify(context)) > MAX_SESSION_WORK_CONTEXT_BYTES
    ) {
      return clearDefinitiveContext({
        contextPackPath,
        env,
        projectDir: normalizedProjectDir,
        privateState,
        reason: 'context_invalid',
        spawnImpl,
      });
    }

    const activation = await activateSessionWorkContext({
      context,
      projectDir: normalizedProjectDir,
      sessionId: privateState.sessionId,
      env,
      spawnImpl,
    });
    if (activation.activated) {
      await removePendingContext(privateState);
    } else {
      const clearance = await clearSessionWorkContext({
        projectDir: normalizedProjectDir,
        sessionId: privateState.sessionId,
        env,
        spawnImpl,
      });
      activation.priorActivationCleared = clearance.cleared;
      activation.clearReason = clearance.reason;
      activation.pendingPath = await persistPendingSessionWorkContext(
        privateState,
        context
      );
    }
    return {
      ok: true,
      contextPackPath,
      sessionContext: activation,
      additionalContext: additionalContextFor(context, activation),
    };
  } catch {
    if (normalizedProjectDir && pickString(sessionId)) {
      const privateState: PrivateContextState = {
        env,
        projectDir: normalizedProjectDir,
        sessionId: pickString(sessionId)!,
        stateRoot,
      };
      return clearUnverifiedContext({
        env,
        projectDir: normalizedProjectDir,
        privateState,
        result: { ok: false, skipped: 'context_pack_hydration_failed' },
        spawnImpl,
      }).catch(() => ({
        ok: false,
        skipped: 'context_pack_hydration_failed',
      }));
    }
    return { ok: false, skipped: 'context_pack_hydration_failed' };
  }
}

/**
 * Activate a context embedded in a trusted Gateway dispatch. Unlike the
 * interactive hydrator above, this path performs no network fetch: the caller
 * must validate the Gateway envelope and digest before invoking it.
 */
export async function activateProvidedSessionWorkContext({
  activationEnvelope,
  context,
  env = process.env,
  projectDir,
  sessionId,
  stateRoot,
  spawnImpl = nodeSpawn as unknown as SpawnLike,
  now = new Date(),
}: {
  activationEnvelope?: unknown;
  context?: unknown;
  env?: Env;
  projectDir?: string;
  sessionId?: string;
  stateRoot?: string;
  spawnImpl?: SpawnLike;
  now?: Date;
} = {}): Promise<ContextPackHydrationResult> {
  const normalizedProjectDir = normalizeAbsoluteHostPath(projectDir);
  try {
    if (!normalizedProjectDir) {
      return { ok: true, skipped: 'project_directory_unavailable' };
    }
    const normalizedId = pickString(sessionId);
    if (!normalizedId || byteLength(normalizedId) > 512) {
      return { ok: true, skipped: 'session_id_unavailable' };
    }
    const privateState: PrivateContextState = {
      env,
      projectDir: normalizedProjectDir,
      sessionId: normalizedId,
      stateRoot,
    };
    if (
      !isRecord(context) ||
      context.schema_version !== 'orgx-session-work-context/v1' ||
      byteLength(canonicalSessionWorkContextJson(context)) >
        MAX_SESSION_WORK_CONTEXT_BYTES
    ) {
      return clearUnverifiedContext({
        env,
        projectDir: normalizedProjectDir,
        privateState,
        result: { ok: true, skipped: 'context_pack_response_invalid' },
        spawnImpl,
      });
    }
    const contextPackPath = await writePrivateJson(
      privateState,
      CONTEXT_PACK_FILENAME,
      {
        receivedAt: now.toISOString(),
        source: 'orgx_gateway_dispatch',
        data: {
          ...(activationEnvelope
            ? { sessionActivation: activationEnvelope }
            : {}),
          sessionWorkContext: context,
        },
      }
    );
    const activation = await activateSessionWorkContext({
      context,
      projectDir: normalizedProjectDir,
      sessionId: normalizedId,
      env,
      spawnImpl,
    });
    if (activation.activated) {
      await removePendingContext(privateState);
    } else {
      const clearance = await clearSessionWorkContext({
        projectDir: normalizedProjectDir,
        sessionId: normalizedId,
        env,
        spawnImpl,
      });
      activation.priorActivationCleared = clearance.cleared;
      activation.clearReason = clearance.reason;
      activation.pendingPath = await persistPendingSessionWorkContext(
        privateState,
        context
      );
    }
    return {
      ok: true,
      contextPackPath,
      sessionContext: activation,
      additionalContext: additionalContextFor(context, activation),
    };
  } catch {
    if (normalizedProjectDir && pickString(sessionId)) {
      const privateState: PrivateContextState = {
        env,
        projectDir: normalizedProjectDir,
        sessionId: pickString(sessionId)!,
        stateRoot,
      };
      return clearUnverifiedContext({
        env,
        projectDir: normalizedProjectDir,
        privateState,
        result: { ok: false, skipped: 'context_pack_hydration_failed' },
        spawnImpl,
      }).catch(() => ({
        ok: false,
        skipped: 'context_pack_hydration_failed',
      }));
    }
    return { ok: false, skipped: 'context_pack_hydration_failed' };
  }
}
