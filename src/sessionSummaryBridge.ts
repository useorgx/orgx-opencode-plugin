import { spawn as nodeSpawn } from 'child_process';
import { access } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

type Env = Record<string, string | undefined>;
type SpawnLike = typeof nodeSpawn;
type ImportHook = (url: string) => Promise<{
  main?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}>;

const EVENT_MAP: Record<string, string> = {
  'session.created': 'SessionStart',
  'session.idle': 'RunEnd',
  'session.error': 'RunEnd',
  'session.deleted': 'SessionEnd',
  'permission.asked': 'PermissionRequest',
  'tool.execute.before': 'PreToolUse',
  'tool.execute.after': 'PostToolUse',
  'tool.execute.failed': 'PostToolUseFailure',
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function duration(...values: unknown[]): number | undefined {
  const value = values.find(
    (candidate) => typeof candidate === 'number' && Number.isFinite(candidate)
  ) as number | undefined;
  return value === undefined ? undefined : Math.max(0, Math.round(value));
}

export function canonicalOpenCodeEvent(
  nativeEvent: string,
  payload?: unknown
): string | null {
  if (nativeEvent === 'message.updated') {
    const properties = record(record(payload).properties);
    const info = record(properties.info);
    return info.role === 'user' ? 'UserPromptSubmit' : null;
  }
  return EVENT_MAP[nativeEvent] ?? null;
}

/** Keep only the bounded metadata admitted by the Wizard summary hook. */
export function sanitizeOpenCodePayload(
  payload: unknown,
  directory: string
): Record<string, unknown> {
  const root = record(payload);
  const properties = record(root.properties);
  const info = record(properties.info);
  return {
    session_id: string(
      root.sessionID,
      root.session_id,
      properties.sessionID,
      properties.session_id,
      info.sessionID,
      info.session_id,
      info.id
    ),
    turn_id: string(
      root.messageID,
      root.callID,
      properties.messageID,
      properties.callID,
      info.messageID
    ),
    cwd: directory,
    tool_name: string(root.tool, root.tool_name, properties.tool),
    tool_use_id: string(root.callID, properties.callID),
    duration_ms: duration(root.duration_ms, root.duration, properties.duration),
    permission_mode: string(root.permission, properties.permission),
  };
}

function defaultHookPath(env: Env): string {
  return (
    string(env.ORGX_SESSION_SUMMARY_HOOK_PATH) ??
    join(
      string(env.XDG_CONFIG_HOME) ?? join(homedir(), '.config'),
      'useorgx',
      'wizard',
      'hooks',
      'orgx-session-summary.mjs'
    )
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function triggerFlush(
  env: Env,
  spawnImpl: SpawnLike,
  queueDir?: string
): boolean {
  try {
    const args = ['hooks', 'flush', '--background', '--limit=25'];
    if (queueDir) args.push(`--queue=${queueDir}`);
    const child = spawnImpl('orgx-wizard', args, {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function bridgeOpenCodeSessionSummary({
  nativeEvent,
  payload,
  directory,
  env = process.env,
  hookPath = defaultHookPath(env),
  importHook = (url) => import(url),
  spawnImpl = nodeSpawn,
}: {
  nativeEvent: string;
  payload?: unknown;
  directory: string;
  env?: Env;
  hookPath?: string;
  importHook?: ImportHook;
  spawnImpl?: SpawnLike;
}): Promise<Record<string, unknown>> {
  const canonicalEvent = canonicalOpenCodeEvent(nativeEvent, payload);
  if (!canonicalEvent) return { ok: true, skipped: 'unsupported_event' };
  if (!(await exists(hookPath))) {
    return { ok: true, skipped: 'wizard_hook_unavailable' };
  }

  const hook = await importHook(pathToFileURL(hookPath).href);
  if (typeof hook.main !== 'function') {
    return { ok: true, skipped: 'wizard_hook_incompatible' };
  }

  const queueDir = string(env.ORGX_SESSION_SUMMARY_QUEUE_DIR);
  const result = await hook.main({
    argv: [
      `--event=${canonicalEvent}`,
      '--source_client=opencode',
      ...(queueDir ? [`--queue_dir=${queueDir}`] : []),
    ],
    env,
    stdinText: JSON.stringify(sanitizeOpenCodePayload(payload, directory)),
  });
  const fallbackDeliveryTriggered =
    result.queued === true && result.delivery_triggered !== true
      ? triggerFlush(env, spawnImpl, queueDir)
      : false;
  return {
    ...result,
    adapter: 'opencode',
    canonical_event: canonicalEvent,
    fallback_delivery_triggered: fallbackDeliveryTriggered,
  };
}
