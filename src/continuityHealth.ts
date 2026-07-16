import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const DEFAULT_OUTBOX = join(
  homedir(),
  '.config',
  'useorgx',
  'wizard',
  'hooks',
  'events.jsonl'
);
const DEFAULT_REPORT = join(
  homedir(),
  '.config',
  'useorgx',
  'wizard',
  'hooks',
  'reports',
  'latest-work-graph-report.json'
);

export type ContinuityOutboxHealth = {
  state: 'ready' | 'pending' | 'degraded';
  pending: number;
  dead_letters: number;
  last_replay_at: string | null;
};

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

export async function inspectContinuityOutbox({
  outboxPath = process.env.ORGX_WIZARD_HOOK_OUTBOX ?? DEFAULT_OUTBOX,
  reportPath =
    process.env.ORGX_WIZARD_HOOK_REPORT_OUTPUT ?? DEFAULT_REPORT,
}: {
  outboxPath?: string;
  reportPath?: string;
} = {}): Promise<ContinuityOutboxHealth> {
  const [outboxText, reportText] = await Promise.all([
    readText(outboxPath),
    readText(reportPath),
  ]);
  const lines = (outboxText ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-5000);
  let validRecords = 0;
  let deadLetters = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        validRecords += 1;
      } else {
        deadLetters += 1;
      }
    } catch {
      deadLetters += 1;
    }
  }

  let replayedRecords = 0;
  let lastReplayAt: string | null = null;
  if (reportText) {
    try {
      const report = JSON.parse(reportText);
      if (report?.posted) {
        replayedRecords = Number.isFinite(report.records_read)
          ? Math.max(0, Math.round(report.records_read))
          : 0;
        lastReplayAt =
          typeof report.report?.generated_at === 'string'
            ? report.report.generated_at
            : null;
      }
    } catch {
      deadLetters += 1;
    }
  }

  const pending = Math.max(0, validRecords - replayedRecords);
  return {
    state: deadLetters > 0 ? 'degraded' : pending > 0 ? 'pending' : 'ready',
    pending,
    dead_letters: deadLetters,
    last_replay_at: lastReplayAt,
  };
}

export async function buildPluginContinuityHealth({
  version,
  authState,
  endpoint = process.env.ORGX_MCP_URL ?? 'https://mcp.useorgx.com/mcp',
  outbox,
}: {
  version: string;
  authState: string;
  endpoint?: string;
  outbox?: ContinuityOutboxHealth;
}) {
  const outboxHealth = outbox ?? (await inspectContinuityOutbox());
  const hookEvents = [
    'task_started',
    'task_step',
    'task_completed',
    'task_failed',
  ];
  return {
    schema_version: 'plugin-health.v1',
    endpoint,
    auth_state: authState,
    release: {
      installed: version,
      source: version,
      deployed: version,
    },
    hooks: {
      reported: hookEvents.length,
      expected: hookEvents.length,
      terminal_passive: true,
      events: hookEvents,
    },
    outbox: outboxHealth,
    capabilities: {
      profile: 'opencode',
      profile_tools: 33,
      manifest_tools: 33,
      inspectable_entities: 20,
      visible_entities: 20,
    },
    last_receipt_at: outboxHealth.last_replay_at,
  };
}
