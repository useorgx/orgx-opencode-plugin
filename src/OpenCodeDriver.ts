/**
 * OpenCodeDriver — the implementation detail inside orgx-opencode-plugin
 * that actually drives the user's OpenCode session.
 *
 * OpenCode exposes a local HTTP API on http://127.0.0.1:<port> when the
 * user has the `opencode` daemon running. We discover the port via the
 * standard XDG state file (~/.opencode/state.json on macOS/Linux,
 * %APPDATA%/opencode/state.json on Windows). When the daemon isn't
 * reachable, detect() reports not-installed and the peer surfaces this
 * to the server on handshake — the server then routes new tasks to a
 * different driver.
 *
 * Dispatch flow:
 *   1. POST /sessions → create a fresh session bound to the task
 *   2. POST /sessions/:id/messages with the rendered prompt
 *   3. Poll /sessions/:id/events until a terminal ('assistant_completed'
 *      or 'error') arrives, streaming task.step events as each tool call
 *      or file_edit lands.
 *   4. Emit task.completed with the accumulated tokens + outcome.
 *
 * Deviation-reporting: every file_edit event is checked against the
 * configured skill rules (fetched from /api/v1/plan-skills on peer
 * connect and cached per run). When a rule matches, we emit
 * task.deviation — the peer forwards it to the server.
 */

import { promises as fs } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

import type {
  Driver,
  DriverStatus,
  DriverProbe,
  DispatchableTask,
  PeerToServerMessage,
} from '@useorgx/orgx-gateway-sdk';

import { recordWorkGraphEvent } from './workGraphOutbox';

type OpenCodeState = {
  port: number;
  version: string;
  session_count: number;
};

type OpenCodeEvent =
  | { kind: 'tool_call'; tool: string; summary: string; ref?: string }
  | { kind: 'file_edit'; path: string; summary: string; diff_ref?: string }
  | { kind: 'chat'; role: 'assistant' | 'user'; text: string }
  | { kind: 'assistant_completed'; tokens_used: number }
  | { kind: 'error'; message: string; recoverable?: boolean };

type SkillRule = {
  skill_id: string;
  match: { pattern: string; on: 'file_edit' | 'tool_call' };
  dedupe_fingerprint: string;
  evidence_kind: string;
};

export type OpenCodeDriverOptions = {
  /** Override the state-file lookup — primarily for tests. */
  statePath?: string;
  /** Async fetcher of skill rules (injected by the peer). */
  skillRules?: () => Promise<SkillRule[]>;
  /** Timeout for each polling round, in ms. */
  pollTimeoutMs?: number;
  /** Local Work Graph JSONL outbox path. Set false to disable. */
  workGraphOutboxPath?: string | false;
  /** Source client name for Work Graph reconciliation. */
  sourceClient?: string;
};

export class OpenCodeDriver implements Driver {
  readonly id = 'opencode' as const;

  private portCache: number | null = null;
  private readonly opts: OpenCodeDriverOptions;

  constructor(opts: OpenCodeDriverOptions = {}) {
    this.opts = opts;
  }

  async detect(): Promise<DriverStatus> {
    try {
      const port = await this.resolvePort();
      this.portCache = port;
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        method: 'GET',
        headers: { 'x-orgx-probe': 'detect' },
      });
      if (!res.ok) {
        return {
          installed: true,
          authenticated: false,
          error: `status ${res.status}`,
        };
      }
      const body = (await res.json()) as { version?: string; authed?: boolean };
      return {
        installed: true,
        authenticated: body.authed !== false,
        version: body.version,
        subscription_active: body.authed !== false,
      };
    } catch (err) {
      return {
        installed: false,
        authenticated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async probe(): Promise<DriverProbe> {
    try {
      const port = await this.resolvePort();
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        method: 'GET',
        headers: { 'x-orgx-probe': 'liveness' },
      });
      if (!res.ok) {
        return { subscription_active: false, session_alive: false };
      }
      const body = (await res.json()) as {
        authed?: boolean;
        session_count?: number;
      };
      return {
        subscription_active: body.authed !== false,
        session_alive: (body.session_count ?? 0) >= 0,
        queue_depth: body.session_count ?? 0,
      };
    } catch {
      return { subscription_active: false, session_alive: false };
    }
  }

  async *dispatch(
    task: DispatchableTask,
    context: { run_id: string; idempotency_key: string }
  ): AsyncIterable<PeerToServerMessage> {
    const port = this.portCache ?? (await this.resolvePort());
    const sessionHandle = await this.createSession(port, {
      title: task.title,
      description: task.description,
      repo_path: task.repo_path,
      skill_ids: task.skill_ids,
      idempotency_key: context.idempotency_key,
    });

    const startedAt = new Date().toISOString();
    await this.recordWorkGraph('task_started', task, context, {
      sessionHandle,
      timestamp: startedAt,
      task_title_chars: task.title.length,
      description_chars: task.description?.length ?? 0,
      skill_count: task.skill_ids?.length ?? 0,
    });
    yield {
      kind: 'task.started',
      run_id: context.run_id,
      started_at: startedAt,
      session_handle: sessionHandle,
    };

    const rules = await (this.opts.skillRules?.() ?? Promise.resolve([]));
    const seenFingerprints = new Set<string>();
    let tokens = 0;
    let firstResponseAt: string | null = null;

    for await (const event of this.streamSessionEvents(port, sessionHandle)) {
      if (!firstResponseAt && (event.kind === 'chat' || event.kind === 'tool_call')) {
        firstResponseAt = new Date().toISOString();
      }

      if (event.kind === 'error') {
        await this.recordWorkGraph('task_failed', task, context, {
          sessionHandle,
          recoverable: event.recoverable === true,
          reason_chars: event.message.length,
        });
        yield {
          kind: 'task.failed',
          run_id: context.run_id,
          reason: event.message,
          recoverable: event.recoverable === true,
        };
        return;
      }

      if (event.kind === 'assistant_completed') {
        tokens = event.tokens_used;
        await this.recordWorkGraph('task_completed', task, context, {
          sessionHandle,
          tokens_used: tokens,
          first_response_seen: Boolean(firstResponseAt),
        });
        yield {
          kind: 'task.completed',
          run_id: context.run_id,
          outcome_kind: 'shipped',
          started_at: startedAt,
          first_response_at: firstResponseAt ?? startedAt,
          completed_at: new Date().toISOString(),
          tokens_used: tokens,
          provider: 'anthropic',
          source_sub_type: 'subscription',
          source_driver: 'opencode',
          // OpenCode subscriptions don't expose a cost per token — we
          // emit 0 so the server's BYOK aggregator records "zero
          // server-side" and leaves saved_estimate_cents to a follow-up
          // job that backfills from task_type_baselines.
          cost_estimate_cents: 0,
        };
        return;
      }

      // Narrate progress to the server + check deviation rules.
      if (event.kind === 'file_edit' || event.kind === 'tool_call') {
        const summary =
          event.kind === 'file_edit'
            ? `edit ${event.path} — ${event.summary}`
            : `call ${event.tool} — ${event.summary}`;
        await this.recordWorkGraph('task_step', task, context, {
          sessionHandle,
          step_kind: event.kind,
          evidence_ref:
            event.kind === 'file_edit'
              ? event.diff_ref ?? event.path
              : event.ref ?? event.tool,
          summary_chars: summary.length,
        });
        yield {
          kind: 'task.step',
          run_id: context.run_id,
          step: {
            kind: event.kind,
            summary,
            evidence_ref:
              event.kind === 'file_edit'
                ? event.diff_ref
                : event.ref,
          },
        };

        for (const rule of rules) {
          if (rule.match.on !== event.kind) continue;
          const text =
            event.kind === 'file_edit'
              ? `${event.path} ${event.summary}`
              : `${event.tool} ${event.summary}`;
          if (!new RegExp(rule.match.pattern).test(text)) continue;
          const dedupe = `${rule.skill_id}:${rule.dedupe_fingerprint}:${context.run_id}`;
          if (seenFingerprints.has(dedupe)) continue;
          seenFingerprints.add(dedupe);
          await this.recordWorkGraph('task_deviation', task, context, {
            sessionHandle,
            skill_id: rule.skill_id,
            evidence_kind: rule.evidence_kind,
            dedupe_key: dedupe,
          });
          yield {
            kind: 'task.deviation',
            run_id: context.run_id,
            skill_id: rule.skill_id,
            evidence_kind: rule.evidence_kind,
            evidence_ref:
              event.kind === 'file_edit'
                ? event.diff_ref ?? event.path
                : event.ref ?? event.tool,
            dedupe_key: dedupe,
            severity: 'warn',
          };
        }
      }
    }
  }

  async cancel(runId: string): Promise<void> {
    const port = this.portCache ?? (await this.resolvePort());
    await fetch(`http://127.0.0.1:${port}/sessions/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correlation_run_id: runId }),
    }).catch(() => undefined);
  }

  // ───── Internals ──────────────────────────────────────────────────────

  private async recordWorkGraph(
    event: string,
    task: DispatchableTask,
    context: { run_id: string; idempotency_key: string },
    summary: Record<string, unknown>
  ): Promise<void> {
    await recordWorkGraphEvent({
      outboxPath: this.opts.workGraphOutboxPath,
      sourceClient: this.opts.sourceClient ?? 'opencode',
      event,
      runId: context.run_id,
      sessionHandle:
        typeof summary.sessionHandle === 'string'
          ? summary.sessionHandle
          : undefined,
      cwd:
        typeof task.repo_path === 'string' && task.repo_path.trim()
          ? task.repo_path
          : undefined,
      summary: {
        ...summary,
        idempotency_key: context.idempotency_key,
      },
    });
  }

  private async resolvePort(): Promise<number> {
    if (this.portCache !== null) return this.portCache;
    const path = this.opts.statePath ?? defaultStatePath();
    const raw = await fs.readFile(path, 'utf8');
    const state = JSON.parse(raw) as OpenCodeState;
    if (!Number.isInteger(state.port) || state.port <= 0) {
      throw new Error(`OpenCode state file missing port: ${path}`);
    }
    this.portCache = state.port;
    return state.port;
  }

  private async createSession(
    port: number,
    body: {
      title: string;
      description?: string;
      repo_path?: string;
      skill_ids?: string[];
      idempotency_key: string;
    }
  ): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': body.idempotency_key,
      },
      body: JSON.stringify({
        title: body.title,
        initial_prompt: renderPrompt(body),
        cwd: body.repo_path,
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenCode /sessions ${res.status}`);
    }
    const json = (await res.json()) as { session_id: string };
    return json.session_id;
  }

  private async *streamSessionEvents(
    port: number,
    sessionId: string
  ): AsyncGenerator<OpenCodeEvent, void, void> {
    const url = `http://127.0.0.1:${port}/sessions/${sessionId}/events`;
    const res = await fetch(url, { headers: { accept: 'application/x-ndjson' } });
    if (!res.ok || !res.body) {
      throw new Error(`OpenCode /events ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as OpenCodeEvent;
        } catch {
          // skip malformed lines
        }
      }
    }
  }
}

function defaultStatePath(): string {
  if (platform() === 'win32') {
    const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, 'opencode', 'state.json');
  }
  return join(homedir(), '.opencode', 'state.json');
}

function renderPrompt(body: {
  title: string;
  description?: string;
  skill_ids?: string[];
}): string {
  const parts = [body.title];
  if (body.description) parts.push('\n\n', body.description);
  if (body.skill_ids?.length) {
    parts.push('\n\nSkills to honor:\n');
    for (const id of body.skill_ids) parts.push(`  - ${id}\n`);
  }
  return parts.join('');
}
