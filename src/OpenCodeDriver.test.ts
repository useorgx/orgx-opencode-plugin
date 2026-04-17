/**
 * OpenCodeDriver unit tests — mock the local daemon via a fake fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeDriver } from './OpenCodeDriver';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function installFetch(handler: Handler) {
  const orig = globalThis.fetch;
  // @ts-expect-error test override
  globalThis.fetch = (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    return Promise.resolve(handler(url, init));
  };
  return () => {
    globalThis.fetch = orig;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjsonResponse(lines: unknown[]): Response {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

describe('OpenCodeDriver', () => {
  let restore: () => void = () => undefined;
  let statePath: string;

  beforeEach(async () => {
    const { mkdtemp, writeFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'ocd-test-'));
    statePath = join(dir, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify({ port: 65123, version: '0.9.0', session_count: 0 })
    );
  });

  afterEach(() => {
    restore();
  });

  it('detect returns installed + authenticated when daemon is healthy', async () => {
    restore = installFetch((url) => {
      if (url.includes('/status')) {
        return jsonResponse({ version: '0.9.0', authed: true });
      }
      return new Response('not found', { status: 404 });
    });
    const d = new OpenCodeDriver({ statePath });
    const s = await d.detect();
    expect(s.installed).toBe(true);
    expect(s.authenticated).toBe(true);
    expect(s.version).toBe('0.9.0');
  });

  it('detect returns installed=false when state file is missing', async () => {
    const d = new OpenCodeDriver({ statePath: '/nonexistent/state.json' });
    const s = await d.detect();
    expect(s.installed).toBe(false);
  });

  it('dispatch yields task.started → task.step → task.completed', async () => {
    const events = [
      { kind: 'tool_call', tool: 'read_file', summary: 'billing.py' },
      {
        kind: 'file_edit',
        path: 'tests/billing.py',
        summary: 'replaced class-based with @parametrize',
      },
      { kind: 'assistant_completed', tokens_used: 3400 },
    ];
    restore = installFetch((url) => {
      if (url.includes('/sessions') && !url.includes('/events')) {
        return jsonResponse({ session_id: 'sess-abc' });
      }
      if (url.includes('/events')) {
        return ndjsonResponse(events);
      }
      return new Response('not found', { status: 404 });
    });

    const d = new OpenCodeDriver({
      statePath,
      skillRules: async () => [],
    });
    const messages: unknown[] = [];
    for await (const m of d.dispatch(
      { title: 'parametrize billing tests', driver: 'opencode' },
      { run_id: 'r1', idempotency_key: 'k1' }
    )) {
      messages.push(m);
    }
    const kinds = messages.map((m) => (m as { kind: string }).kind);
    expect(kinds).toContain('task.started');
    expect(kinds.filter((k) => k === 'task.step').length).toBe(2);
    expect(kinds[kinds.length - 1]).toBe('task.completed');
  });

  it('emits task.deviation when a skill rule matches a file_edit', async () => {
    const events = [
      {
        kind: 'file_edit',
        path: 'tests/billing.py',
        summary: 'replaced class-based with parametrize',
      },
      { kind: 'assistant_completed', tokens_used: 1000 },
    ];
    restore = installFetch((url) => {
      if (url.includes('/sessions') && !url.includes('/events')) {
        return jsonResponse({ session_id: 'sess-abc' });
      }
      if (url.includes('/events')) return ndjsonResponse(events);
      return new Response('not found', { status: 404 });
    });

    const d = new OpenCodeDriver({
      statePath,
      skillRules: async () => [
        {
          skill_id: 'parametrize-tests',
          match: { pattern: 'parametrize', on: 'file_edit' },
          dedupe_fingerprint: 'parametrize-tests-v1',
          evidence_kind: 'test_style_shift',
        },
      ],
    });
    const messages: unknown[] = [];
    for await (const m of d.dispatch(
      { title: 'parametrize billing tests', driver: 'opencode' },
      { run_id: 'r1', idempotency_key: 'k1' }
    )) {
      messages.push(m);
    }
    const deviations = messages.filter(
      (m) => (m as { kind: string }).kind === 'task.deviation'
    );
    expect(deviations).toHaveLength(1);
    expect(deviations[0]).toMatchObject({
      skill_id: 'parametrize-tests',
      evidence_kind: 'test_style_shift',
    });
  });

  it('emits task.failed when an error event lands', async () => {
    const events = [
      { kind: 'error', message: 'session interrupted', recoverable: true },
    ];
    restore = installFetch((url) => {
      if (url.includes('/sessions') && !url.includes('/events')) {
        return jsonResponse({ session_id: 'sess-abc' });
      }
      if (url.includes('/events')) return ndjsonResponse(events);
      return new Response('not found', { status: 404 });
    });
    const d = new OpenCodeDriver({
      statePath,
      skillRules: async () => [],
    });
    const messages: unknown[] = [];
    for await (const m of d.dispatch(
      { title: 'x', driver: 'opencode' },
      { run_id: 'r1', idempotency_key: 'k1' }
    )) {
      messages.push(m);
    }
    expect(messages[messages.length - 1]).toMatchObject({
      kind: 'task.failed',
      recoverable: true,
    });
  });
});
