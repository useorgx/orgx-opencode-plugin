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
    expect(
      canonicalOpenCodeEvent('message.updated', {
        properties: { info: { role: 'user' } },
      })
    ).toBe('UserPromptSubmit');
    expect(
      canonicalOpenCodeEvent('message.updated', {
        properties: { info: { role: 'assistant' } },
      })
    ).toBeNull();
  });

  it('drops messages, tool arguments/results, and errors at the adapter boundary', () => {
    const result = sanitizeOpenCodePayload(
      {
        sessionID: 'session-1',
        callID: 'call-2',
        tool: 'bash',
        duration: 44.8,
        message: 'private message',
        args: { command: 'private command' },
        output: 'private output',
        error: 'private error',
      },
      '/work/repo'
    );
    expect(result).toEqual({
      session_id: 'session-1',
      turn_id: 'call-2',
      cwd: '/work/repo',
      tool_name: 'bash',
      tool_use_id: 'call-2',
      duration_ms: 45,
      permission_mode: undefined,
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      'private message',
      'private command',
      'private output',
      'private error',
    ]) {
      expect(serialized).not.toContain(secret);
    }
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
        argv: ['--event=RunEnd', '--source_client=opencode'],
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
