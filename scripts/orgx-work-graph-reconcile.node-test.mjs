import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  buildWorkGraphReport,
  isDirectRun,
  loadHookOutboxRecords,
  main,
  normalizeSourceClient,
  parseArgs,
  postWorkGraphReport,
} from './orgx-work-graph-reconcile.mjs';

const NOW = '2026-05-07T12:00:00.000Z';

function hookRecord(overrides = {}) {
  return {
    schema_version: '2026-05-07',
    source: 'orgx_opencode_plugin_runtime_hook',
    source_client: 'opencode',
    event: 'task_step',
    run_id: 'run-1',
    session_id: 'session-1',
    cwd: '/Users/example/Code/orgx',
    timestamp: NOW,
    summary: {
      tool_name: 'mcp__orgx__entity_action',
      prompt_chars: 42,
      payload_keys: ['tool_name', 'cwd'],
    },
    ...overrides,
  };
}

test('work graph reconciler normalizes shared client names', () => {
  assert.equal(normalizeSourceClient('claude_code'), 'claude-code');
  assert.equal(normalizeSourceClient('open-claw'), 'openclaw');
});

test('work graph reconciler posts reports privately with server dedupe', async () => {
  let requestBody;
  await postWorkGraphReport({
    report: { idempotency_key: 'stable-fingerprint' },
    baseUrl: 'https://example.org',
    apiKey: 'oxk_test_only',
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(requestBody.public_share, false);
  assert.equal(requestBody.report.idempotency_key, 'stable-fingerprint');
});

test('work graph reconciler parses split CLI values', () => {
  const args = parseArgs(['--outbox', '/tmp/events.jsonl', '--post']);
  assert.equal(args.outbox, '/tmp/events.jsonl');
  assert.equal(args.post, 'true');
});

test('work graph reconciler direct-run check resolves npm bin symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgx-opencode-bin-'));
  const target = join(dir, 'orgx-work-graph-reconcile.mjs');
  const bin = join(dir, 'orgx-opencode-reconcile-hooks');
  writeFileSync(target, '#!/usr/bin/env node\n', 'utf8');
  symlinkSync(target, bin);

  assert.equal(
    isDirectRun({ invokedPath: bin, moduleUrl: pathToFileURL(target).href }),
    true
  );
});

test('work graph reconciler reads OpenCode hook outbox jsonl', async () => {
  const outbox = join(mkdtempSync(join(tmpdir(), 'orgx-opencode-reconcile-')), 'events.jsonl');
  writeFileSync(outbox, `${JSON.stringify(hookRecord())}\nnot json\n`, 'utf8');

  const loaded = await loadHookOutboxRecords(outbox);
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.skipped, 1);
  assert.equal(loaded.records[0].source_client, 'opencode');
});

test('work graph reconciler emits OrgX-compatible summary-only report', () => {
  const report = buildWorkGraphReport([hookRecord()], {
    generatedAt: NOW,
    workspaceCwd: '/Users/example/Code/orgx',
  });

  assert.match(report.work_graph_fingerprint, /^wgf_[0-9a-f]{24}$/);
  assert.equal(
    report.signup_hydration.hydration_key,
    `orgx:work-graph:${report.work_graph_fingerprint}`
  );
  assert.equal(report.source_client, 'wizard');
  assert.equal(report.raw_transcripts_sent, false);
  assert.equal(report.investigation.raw_transcripts_excluded, true);
  assert.equal(report.investigation.fingerprint, report.work_graph_fingerprint);
  assert.equal(report.investigation.generated_at, NOW);
  assert.equal(typeof report.investigation.why_not_100[0], 'object');
  assert.equal(report.events[0].event_type, 'tool_signal');
  assert.equal(report.source_coverage.orgxMcpCalled, true);
  assert.deepEqual(report.missed_orchestration_opportunities, []);
});

test('work graph reconciler dry-run writes report without credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgx-opencode-reconcile-main-'));
  const outbox = join(dir, 'events.jsonl');
  const output = join(dir, 'report.json');
  writeFileSync(outbox, `${JSON.stringify(hookRecord())}\n`, 'utf8');

  const result = await main({
    argv: [`--outbox=${outbox}`, `--output=${output}`, '--cwd=/repo'],
    env: {},
    now: () => new Date(NOW),
  });

  assert.equal(result.ok, true);
  assert.equal(result.records_read, 1);
  const written = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(written.work_graph_fingerprint, result.work_graph_fingerprint);
  assert.equal(written.report.raw_transcripts_sent, false);
});
