import { appendFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';

type WorkGraphEventInput = {
  outboxPath?: string | false;
  sourceClient?: string;
  event: string;
  runId?: string;
  sessionHandle?: string;
  cwd?: string;
  timestamp?: string;
  summary?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
};

export function resolveWorkGraphOutboxPath(
  outboxPath?: string | false,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (outboxPath === false) return null;
  const explicit = typeof outboxPath === 'string' ? outboxPath.trim() : '';
  if (explicit) return explicit;
  const envPath = env.ORGX_WIZARD_HOOK_OUTBOX?.trim();
  if (envPath) return envPath;
  return join(homedir(), '.config', 'useorgx', 'wizard', 'hooks', 'events.jsonl');
}

export function buildWorkGraphEventRecord({
  sourceClient = 'opencode',
  event,
  runId,
  sessionHandle,
  cwd,
  timestamp = new Date().toISOString(),
  summary = {},
}: WorkGraphEventInput): Record<string, unknown> {
  return {
    schema_version: '2026-05-07',
    source: 'orgx_opencode_plugin_runtime_hook',
    source_client: sourceClient,
    event,
    session_id: runId,
    turn_id: sessionHandle,
    cwd,
    timestamp,
    summary,
  };
}

export async function recordWorkGraphEvent(
  input: WorkGraphEventInput
): Promise<boolean> {
  const outbox = resolveWorkGraphOutboxPath(input.outboxPath, input.env);
  if (!outbox) return false;

  try {
    await mkdir(dirname(outbox), { recursive: true, mode: 0o700 });
    await appendFile(
      outbox,
      `${JSON.stringify(buildWorkGraphEventRecord(input))}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
      }
    );
    return true;
  } catch {
    return false;
  }
}
