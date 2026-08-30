import { writeFile } from 'fs/promises';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  bridgeOpenCodeSessionSummary,
  canonicalOpenCodeEvent,
  sanitizeOpenCodePayload,
} from './sessionSummaryBridge';

describe('OpenCode session summary bridge', () => {
  it('maps stable lifecycle events to the shared run contract', () => {
    expect(canonicalOpenCodeEvent('session.created')).toBe('SessionStart');
    expect(canonicalOpenCodeEvent('session.idle')).toBe('RunEnd');
    expect(canonicalOpenCodeEvent('session.deleted')).toBe('SessionEnd');
    expect(canonicalOpenCodeEvent('session.abandoned')).toBe(
      'SessionAbandoned'
    );
    expect(canonicalOpenCodeEvent('chat.message')).toBe('UserPromptSubmit');
    expect(
      canonicalOpenCodeEvent('message.updated', {
        properties: { info: { role: 'user' } },
      })
    ).toBeNull();
    expect(
      canonicalOpenCodeEvent('message.updated', {
        properties: { info: { role: 'assistant' } },
      })
    ).toBeNull();
  });

  it('captures one prompt for the native chat.message then message.updated lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgx-opencode-bridge-'));
    const hookPath = join(dir, 'orgx-session-summary.mjs');
    await writeFile(hookPath, 'export async function main() {}\n', 'utf8');
    const main = vi.fn(async () => ({ ok: true }));
    try {
      const promptResult = await bridgeOpenCodeSessionSummary({
        nativeEvent: 'chat.message',
        payload: {
          sessionID: 'session-1',
          messageID: 'message-1',
          prompt: 'One native user prompt.',
        },
        directory: '/work/repo',
        hookPath,
        importHook: async () => ({ main }),
      });
      const updateResult = await bridgeOpenCodeSessionSummary({
        nativeEvent: 'message.updated',
        payload: {
          properties: {
            info: { id: 'message-1', sessionID: 'session-1', role: 'user' },
          },
        },
        directory: '/work/repo',
        hookPath,
        importHook: async () => ({ main }),
      });

      expect(promptResult).toMatchObject({
        ok: true,
        canonical_event: 'UserPromptSubmit',
      });
      expect(updateResult).toEqual({ ok: true, skipped: 'unsupported_event' });
      expect(main).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps bounded user intent while dropping tool arguments/results and errors', () => {
    const result = sanitizeOpenCodePayload(
      {
        sessionID: 'session-1',
        callID: 'call-2',
        tool: 'bash',
        duration: 44.8,
        prompt: 'Implement the verified work ledger.',
        parentSessionID: 'parent-1',
        args: { command: 'private command' },
        output: 'private output',
        error: 'private error',
      },
      '/work/repo',
      { ORGX_SESSION_WORK_EPISODE_CAPTURE: 'bounded' }
    );
    expect(result).toEqual({
      session_id: 'session-1',
      turn_id: 'call-2',
      cwd: '/work/repo',
      tool_name: 'bash',
      tool_use_id: 'call-2',
      duration_ms: 45,
      permission_mode: undefined,
      prompt: 'Implement the verified work ledger.',
      root_session_id: undefined,
      parent_session_id: 'parent-1',
      resumed_from_session_id: undefined,
      action_effect: 'execute',
      action_target: undefined,
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      'private command',
      'private output',
      'private error',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('Implement the verified work ledger.');
  });

  it('defaults to metadata-only capture and honors explicit bounded consent', () => {
    const payload = {
      sessionID: 'session-consent',
      prompt: 'Only retain this when bounded capture is enabled.',
    };

    expect(sanitizeOpenCodePayload(payload, '/work/repo').prompt).toBeUndefined();
    expect(
      sanitizeOpenCodePayload(payload, '/work/repo', {
        ORGX_SESSION_WORK_EPISODE_CAPTURE: '1',
      }).prompt
    ).toBe('Only retain this when bounded capture is enabled.');
  });

  it('bounds explicitly enabled prompt capture to 600 Unicode characters', () => {
    const prompt = `${'a'.repeat(599)}🧠${'b'.repeat(100)}`;

    const sanitized = sanitizeOpenCodePayload(
      { sessionID: 'session-bounded', prompt },
      '/work/repo',
      { ORGX_SESSION_WORK_EPISODE_CAPTURE: 'bounded' }
    );

    expect(Array.from(sanitized.prompt as string)).toHaveLength(600);
    expect(sanitized.prompt).toBe(`${'a'.repeat(599)}🧠`);
  });

  it('delegates to Wizard and starts fallback delivery for a run end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgx-opencode-bridge-'));
    const hookPath = join(dir, 'orgx-session-summary.mjs');
    await writeFile(hookPath, 'export async function main() {}\n', 'utf8');
    const main = vi.fn(async () => ({
      ok: true,
      queued: true,
      delivery_triggered: false,
    }));
    const unref = vi.fn();
    const spawnImpl = vi.fn(
      () => ({ on: vi.fn(), unref }) as unknown as ReturnType<typeof import('child_process').spawn>
    );
    try {
      const result = await bridgeOpenCodeSessionSummary({
        nativeEvent: 'session.idle',
        payload: { properties: { sessionID: 'session-1' } },
        directory: '/work/repo',
        hookPath,
        env: { PATH: process.env.PATH },
        importHook: async () => ({ main }),
        spawnImpl,
      });

      expect(main).toHaveBeenCalledWith({
        argv: [
          '--event=RunEnd',
          '--source_client=opencode',
        ],
        env: { PATH: process.env.PATH },
        stdinText: JSON.stringify({
          session_id: 'session-1',
          cwd: '/work/repo',
        }),
      });
      expect(result.fallback_delivery_triggered).toBe(true);
      expect(spawnImpl).toHaveBeenCalledWith(
        'orgx-wizard',
        ['hooks', 'flush', '--background', '--limit=25'],
        expect.objectContaining({ detached: true, stdio: 'ignore' })
      );
      expect(unref).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves Work Episode consent to the explicit Wizard environment setting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgx-opencode-bridge-'));
    const hookPath = join(dir, 'orgx-session-summary.mjs');
    await writeFile(hookPath, 'export async function main() {}\n', 'utf8');
    const main = vi.fn(async () => ({ ok: true }));
    try {
      await bridgeOpenCodeSessionSummary({
        nativeEvent: 'chat.message',
        payload: {
          sessionID: 'session-consent',
          prompt: 'Retain this bounded intent.',
        },
        directory: '/work/repo',
        hookPath,
        env: {
          PATH: process.env.PATH,
          ORGX_SESSION_WORK_EPISODE_CAPTURE: 'bounded',
        },
        importHook: async () => ({ main }),
      });

      expect(main).toHaveBeenCalledTimes(1);
      expect(main.mock.calls[0][0].argv).toEqual([
        '--event=UserPromptSubmit',
        '--source_client=opencode',
      ]);
      expect(main.mock.calls[0][0].env.ORGX_SESSION_WORK_EPISODE_CAPTURE).toBe(
        'bounded'
      );
      expect(JSON.parse(main.mock.calls[0][0].stdinText).prompt).toBe(
        'Retain this bounded intent.'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an offline run queued without starting fallback delivery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgx-opencode-bridge-'));
    const hookPath = join(dir, 'orgx-session-summary.mjs');
    await writeFile(hookPath, 'export async function main() {}\n', 'utf8');
    const spawnImpl = vi.fn();
    try {
      const result = await bridgeOpenCodeSessionSummary({
        nativeEvent: 'session.idle',
        payload: { properties: { sessionID: 'session-offline' } },
        directory: '/work/repo',
        hookPath,
        env: {
          PATH: process.env.PATH,
          ORGX_SESSION_SUMMARY_AUTO_FLUSH: 'off',
        },
        importHook: async () => ({
          main: async () => ({ ok: true, queued: true, delivery_triggered: false }),
        }),
        spawnImpl,
      });

      expect(result.fallback_delivery_triggered).toBe(false);
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the installed-hook dependency when unavailable', async () => {
    await expect(
      bridgeOpenCodeSessionSummary({
        nativeEvent: 'session.idle',
        directory: '/work/repo',
        hookPath: '/definitely/absent/orgx-session-summary.mjs',
      })
    ).resolves.toEqual({ ok: true, skipped: 'wizard_hook_unavailable' });
  });
});
