import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_PACK_FILENAME,
  MAX_CONTEXT_PACK_RESPONSE_BYTES,
  MAX_WIZARD_OUTPUT_BYTES,
  PENDING_CONTEXT_FILENAME,
  activateProvidedSessionWorkContext,
  buildContextPackRequest,
  clearSessionWorkContext,
  hydrateContextPack as hydrateContextPackImpl,
  resolveContextPackConfig,
  resolvePrivateContextStateDirectory,
  resolveSafeBaseUrl,
  sessionWorkContextSha256,
  type SpawnLike,
} from './contextPackHydration.js';

type HydrationInput = NonNullable<
  Parameters<typeof hydrateContextPackImpl>[0]
>;

const testStateRoots = new Set<string>();

afterEach(() => {
  for (const path of testStateRoots) {
    rmSync(path, { recursive: true, force: true });
  }
  testStateRoots.clear();
});

function testStateRoot(projectDir: string): string {
  const root = join(tmpdir(), `${basename(projectDir)}-private-orgx-state`);
  testStateRoots.add(root);
  return root;
}

function stateDirectory(projectDir: string, sessionId = 'session-1'): string {
  return resolvePrivateContextStateDirectory({
    projectDir,
    sessionId,
    stateRoot: testStateRoot(projectDir),
  })!;
}

function hydrateContextPack(input: HydrationInput) {
  return hydrateContextPackImpl({
    ...input,
    sessionId: input.sessionId ?? 'session-1',
    stateRoot:
      input.stateRoot ??
      (input.projectDir && isAbsolute(input.projectDir)
        ? testStateRoot(input.projectDir)
        : undefined),
  });
}

const sessionWorkContext = {
  schema_version: 'orgx-session-work-context/v1',
  provenance: 'producer_asserted',
  intent: {
    summary: 'Continue the accepted OpenCode implementation slice.',
    acceptance_criteria: ['Focused checks pass'],
    constraints: ['Do not invent authority'],
  },
  authority: {
    mode: 'explicit',
    status: 'granted',
    scope: { actions: ['edit'], resources: [], systems: ['opencode'] },
    constraints: [],
  },
  cost: { availability: 'not_observed' },
  artifact_refs: [],
  evidence_refs: [],
};

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status });
}

function wizardProcess(
  calls: Array<Record<string, unknown>>,
  exitCode = 0,
  stdoutValue?: string | ((args: string[]) => string)
): SpawnLike {
  return (command, args, options) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: EventEmitter;
      kill: () => void;
    };
    const chunks: Buffer[] = [];
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    child.stdout = new EventEmitter();
    child.stdin.once('finish', () => {
      calls.push({
        command,
        args,
        options,
        input: Buffer.concat(chunks).toString('utf8'),
      });
      queueMicrotask(() => {
        if (exitCode === 0) {
          const configured =
            typeof stdoutValue === 'function'
              ? stdoutValue(args)
              : stdoutValue;
          const cwd = args[args.indexOf('--cwd') + 1];
          const sourceClient = args[args.indexOf('--source-client') + 1];
          const sessionId = args[args.indexOf('--session-id') + 1];
          const contextSha256 = args[args.indexOf('--context-sha256') + 1];
          const clearing = args.includes('clear');
          child.stdout.emit(
            'data',
            configured ??
              JSON.stringify(
                clearing
                  ? {
                      ackVersion: 'orgx-session-work-context-ack/v1',
                      ready: false,
                      state: 'missing',
                      cleared: true,
                      cwd,
                      sourceClient,
                      sessionId,
                    }
                  : {
                      ackVersion: 'orgx-session-work-context-ack/v1',
                      activationVersion:
                        'orgx-session-work-context-activation/v2',
                      ready: true,
                      state: 'ready',
                      cwd,
                      sourceClient,
                      sessionId,
                      contextSha256,
                    }
              )
          );
        }
        child.emit('close', exitCode);
      });
    });
    child.kill = vi.fn();
    return child;
  };
}

describe('opencode context-pack hydration', () => {
  it('resolves task, workstream, initiative, then workspace anchor priority', () => {
    const config = resolveContextPackConfig({
      ORGX_API_KEY: 'oxk_test',
      ORGX_BASE_URL: 'https://useorgx.com/',
      ORGX_TASK_ID: 'task-1',
      ORGX_WORKSTREAM_ID: 'workstream-2',
      ORGX_INITIATIVE_ID: 'initiative-3',
      ORGX_WORKSPACE_ID: 'workspace-4',
    });

    expect(config?.anchor).toEqual({
      type: 'task',
      id: 'task-1',
      requestField: 'task_id',
    });
    expect(buildContextPackRequest(config!)).toEqual({
      url: 'https://useorgx.com/api/v1/context-pack',
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer oxk_test',
        },
        body: JSON.stringify({
          workspace_id: 'workspace-4',
          initiative_id: 'initiative-3',
          workstream_id: 'workstream-2',
          task_id: 'task-1',
        }),
        redirect: 'error',
      },
    });
  });

  it('builds the canonical request field for every supported anchor', () => {
    for (const [envKey, id, requestField] of [
      ['ORGX_TASK_ID', 'task-1', 'task_id'],
      ['ORGX_WORKSTREAM_ID', 'workstream-1', 'workstream_id'],
      ['ORGX_INITIATIVE_ID', 'initiative-1', 'initiative_id'],
      ['ORGX_WORKSPACE_ID', 'workspace-1', 'workspace_id'],
    ]) {
      const config = resolveContextPackConfig({
        ORGX_API_KEY: 'oxk_test',
        [envKey]: id,
      });
      expect(JSON.parse(buildContextPackRequest(config!).init.body as string)).toEqual({
        [requestField]: id,
      });
    }
  });

  it('rejects base URLs that could carry credentials or redirect insecurely', () => {
    expect(resolveSafeBaseUrl('https://user:pass@useorgx.com')).toBeNull();
    expect(resolveSafeBaseUrl('https://useorgx.com?token=secret')).toBeNull();
    expect(resolveSafeBaseUrl('https://useorgx.com#secret')).toBeNull();
    expect(resolveSafeBaseUrl('https://useorgx.com/redirect')).toBeNull();
    expect(resolveSafeBaseUrl('http://useorgx.com')).toBeNull();
    expect(resolveSafeBaseUrl('http://localhost:3000/')).toBe(
      'http://localhost:3000'
    );
    expect(resolveSafeBaseUrl(undefined)).toBe('https://useorgx.com');
  });

  it('requires an API key and one authoritative anchor', () => {
    expect(resolveContextPackConfig({})).toBeNull();
    expect(resolveContextPackConfig({ ORGX_API_KEY: 'oxk_test' })).toBeNull();
    expect(
      resolveContextPackConfig({
        ORGX_API_KEY: 'oxk_test',
        ORGX_TASK_ID: 'task-1',
        ORGX_BASE_URL: 'https://user:secret@example.test',
      })
    ).toBeNull();
  });

  it('requires a native session ID before fetching or writing context', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const fetchImpl = vi.fn();
    try {
      await expect(
        hydrateContextPackImpl({
          env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
          projectDir,
          sessionId: '   ',
          stateRoot: testStateRoot(projectDir),
          fetchImpl,
        })
      ).resolves.toEqual({ ok: true, skipped: 'session_id_unavailable' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(existsSync(testStateRoot(projectDir))).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('derives distinct SHA-256 state directories from resolved cwd and native session ID', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    try {
      const first = stateDirectory(projectDir, 'session-a');
      const second = stateDirectory(projectDir, 'session-b');
      expect(first).not.toBe(second);
      expect(first).toMatch(/[a-f0-9]{64}$/);
      expect(second).toMatch(/[a-f0-9]{64}$/);
      expect(first).not.toContain('session-a');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('hashes recursively key-sorted JSON while preserving array order', () => {
    const digest = sessionWorkContextSha256({
      z: [{ b: 2, a: 1 }, undefined, 'last'],
      a: { d: 4, c: 3 },
      omitted: undefined,
    });
    expect(digest).toBe(
      'e2599a20c4da09859bff6b025e72065db6e559af9d36c68b82b010f5c471edda'
    );
    expect(digest).toBe(
      sessionWorkContextSha256({
        a: { c: 3, d: 4 },
        z: [{ a: 1, b: 2 }, 'last'],
      })
    );
    expect(sessionWorkContextSha256({ values: ['a', 'b'] })).not.toBe(
      sessionWorkContextSha256({ values: ['b', 'a'] })
    );
  });

  it('retains the pack in private session state and forwards exact context to Wizard', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const requests: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const wizardCalls: Array<Record<string, unknown>> = [];
    const now = new Date('2026-08-24T20:00:00.000Z');
    try {
      const result = await hydrateContextPack({
        env: {
          PATH: process.env.PATH,
          ORGX_API_KEY: 'oxk_test',
          ORGX_GATEWAY_KEY: 'oxk_alias',
          ORGX_TASK_ID: 'task-1',
        },
        projectDir,
        fetchImpl: vi.fn(async (url, init) => {
          requests.push({ url, init });
          return response({ frame: { anchor: 'task-1' }, sessionWorkContext });
        }),
        spawnImpl: wizardProcess(wizardCalls),
        now,
      });

      expect(result).toMatchObject({
        ok: true,
        contextPackPath: join(stateDirectory(projectDir), CONTEXT_PACK_FILENAME),
        sessionContext: { activated: true, reason: 'wizard_activated' },
      });
      expect(result.additionalContext).toContain('Continue the accepted OpenCode');
      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0].init?.body as string)).toEqual({
        task_id: 'task-1',
      });

      const packPath = join(stateDirectory(projectDir), CONTEXT_PACK_FILENAME);
      expect(JSON.parse(readFileSync(packPath, 'utf8'))).toEqual({
        fetchedAt: now.toISOString(),
        data: { frame: { anchor: 'task-1' }, sessionWorkContext },
      });
      expect(statSync(packPath).mode & 0o777).toBe(0o600);
      expect(existsSync(join(projectDir, '.opencode'))).toBe(false);

      expect(wizardCalls).toHaveLength(1);
      expect(wizardCalls[0].command).toBe('orgx-wizard');
      expect(wizardCalls[0].args).toEqual([
        'sessions',
        'context',
        'set',
        '--file',
        '-',
        '--cwd',
        projectDir,
        '--source-client',
        'opencode',
        '--session-id',
        'session-1',
        '--context-sha256',
        sessionWorkContextSha256(sessionWorkContext),
        '--json',
      ]);
      expect(JSON.parse(wizardCalls[0].input as string)).toEqual(
        sessionWorkContext
      );
      const wizardEnv = (
        wizardCalls[0].options as { env: Record<string, string | undefined> }
      ).env;
      expect(wizardEnv).not.toHaveProperty('ORGX_API_KEY');
      expect(wizardEnv).not.toHaveProperty('ORGX_GATEWAY_KEY');
      expect(
        existsSync(join(stateDirectory(projectDir), PENDING_CONTEXT_FILENAME))
      ).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('activates a Gateway-provided context without a network fetch', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const wizardCalls: Array<Record<string, unknown>> = [];
    const stateRoot = testStateRoot(projectDir);
    const now = new Date('2026-08-26T15:00:00.000Z');
    const activationEnvelope = {
      schema_version: 'orgx-session-activation/v1',
      scope: { workspace_id: 'workspace-1', task_id: 'task-1' },
      work_context: sessionWorkContext,
      compaction: { compacted: false },
    };
    try {
      const result = await activateProvidedSessionWorkContext({
        activationEnvelope,
        context: sessionWorkContext,
        env: { PATH: process.env.PATH },
        projectDir,
        sessionId: 'gateway-session-1',
        stateRoot,
        spawnImpl: wizardProcess(wizardCalls),
        now,
      });

      expect(result).toMatchObject({
        ok: true,
        sessionContext: { activated: true, reason: 'wizard_activated' },
      });
      expect(wizardCalls).toHaveLength(1);
      expect(wizardCalls[0].args).toContain(
        sessionWorkContextSha256(sessionWorkContext)
      );
      const packPath = join(
        resolvePrivateContextStateDirectory({
          projectDir,
          sessionId: 'gateway-session-1',
          stateRoot,
        })!,
        CONTEXT_PACK_FILENAME
      );
      expect(JSON.parse(readFileSync(packPath, 'utf8'))).toEqual({
        receivedAt: now.toISOString(),
        source: 'orgx_gateway_dispatch',
        data: { sessionActivation: activationEnvelope, sessionWorkContext },
      });
      expect(statSync(packPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps same-project sessions in distinct owner-local Wizard state', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-project-'));
    const wizardHome = mkdtempSync(join(tmpdir(), 'orgx-wizard-home-'));
    try {
      const hydrateSession = (sessionId: string) =>
        hydrateContextPackImpl({
          env: {
            ORGX_API_KEY: 'oxk_test',
            ORGX_TASK_ID: 'task-1',
            ORGX_WIZARD_CONFIG_HOME: wizardHome,
          },
          projectDir,
          sessionId,
          fetchImpl: vi.fn(async () => response({ sessionWorkContext })),
          spawnImpl: wizardProcess([]),
        });
      const first = await hydrateSession('session-a');
      const second = await hydrateSession('session-b');

      expect(first.contextPackPath).toBe(
        join(
          resolvePrivateContextStateDirectory({
            env: { ORGX_WIZARD_CONFIG_HOME: wizardHome },
            projectDir,
            sessionId: 'session-a',
          })!,
          CONTEXT_PACK_FILENAME
        )
      );
      expect(second.contextPackPath).not.toBe(first.contextPackPath);
      expect(first.contextPackPath?.startsWith(wizardHome)).toBe(true);
      expect(second.contextPackPath?.startsWith(wizardHome)).toBe(true);
      expect(existsSync(join(projectDir, '.opencode'))).toBe(false);
      expect(statSync(first.contextPackPath!).mode & 0o777).toBe(0o600);
      expect(
        statSync(join(first.contextPackPath!, '..')).mode & 0o777
      ).toBe(0o700);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(wizardHome, { recursive: true, force: true });
    }
  });

  it('refuses an explicitly configured state root inside the repository and clears the session lease', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-project-'));
    const repoStateRoot = join(projectDir, '.private-runtime');
    const wizardCalls: Array<Record<string, unknown>> = [];
    try {
      const result = await hydrateContextPackImpl({
        env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
        projectDir,
        sessionId: 'session-1',
        stateRoot: repoStateRoot,
        fetchImpl: vi.fn(async () => response({ sessionWorkContext })),
        spawnImpl: wizardProcess(wizardCalls),
      });

      expect(result).toMatchObject({
        ok: false,
        skipped: 'context_pack_hydration_failed',
        sessionContext: {
          activated: false,
          reason: 'context_refresh_failed',
          priorActivationCleared: true,
        },
      });
      expect(existsSync(repoStateRoot)).toBe(false);
      expect(wizardCalls).toHaveLength(1);
      expect((wizardCalls[0].args as string[]).slice(0, 3)).toEqual([
        'sessions',
        'context',
        'clear',
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('persists exact pending activation when Wizard is unavailable', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    try {
      const result = await hydrateContextPack({
        env: {
          ORGX_API_KEY: 'oxk_test',
          ORGX_INITIATIVE_ID: 'initiative-1',
        },
        projectDir,
        fetchImpl: vi.fn(async () => response({ sessionWorkContext })),
        spawnImpl: () => {
          throw new Error('orgx-wizard unavailable');
        },
      });

      const pendingPath = join(stateDirectory(projectDir), PENDING_CONTEXT_FILENAME);
      expect(result.sessionContext).toEqual({
        activated: false,
        reason: 'wizard_unavailable',
        priorActivationCleared: false,
        clearReason: 'wizard_unavailable',
        pendingPath,
      });
      expect(JSON.parse(readFileSync(pendingPath, 'utf8'))).toEqual(
        sessionWorkContext
      );
      expect(statSync(pendingPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not rewrite app not-observed cost when Wizard rejects the contract', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const wizardCalls: Array<Record<string, unknown>> = [];
    try {
      const result = await hydrateContextPack({
        env: {
          ORGX_API_KEY: 'oxk_test',
          ORGX_TASK_ID: 'task-cost-contract',
        },
        projectDir,
        fetchImpl: vi.fn(async () => response({ sessionWorkContext })),
        spawnImpl: wizardProcess(wizardCalls, 1),
      });

      expect(result.sessionContext?.reason).toBe('wizard_rejected');
      expect(JSON.parse(wizardCalls[0].input as string).cost).toEqual({
        availability: 'not_observed',
      });
      const pendingPath = join(stateDirectory(projectDir), PENDING_CONTEXT_FILENAME);
      expect(JSON.parse(readFileSync(pendingPath, 'utf8')).cost).toEqual({
        availability: 'not_observed',
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('retains a workspace pack and clears stale exact-cwd activation', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const wizardCalls: Array<Record<string, unknown>> = [];
    try {
      const result = await hydrateContextPack({
        env: {
          ORGX_API_KEY: 'oxk_test',
          ORGX_WORKSPACE_ID: 'workspace-1',
        },
        projectDir,
        fetchImpl: vi.fn(async () =>
          response({ contextCapsule: { workspaceId: 'workspace-1' } })
        ),
        spawnImpl: wizardProcess(wizardCalls),
      });

      expect(result.sessionContext).toEqual({
        activated: false,
        reason: 'not_returned',
        priorActivationCleared: true,
        clearReason: 'wizard_cleared',
      });
      expect(wizardCalls[0].args).toEqual([
        'sessions',
        'context',
        'clear',
        '--cwd',
        projectDir,
        '--source-client',
        'opencode',
        '--session-id',
        'session-1',
        '--json',
      ]);
      expect(
        existsSync(join(stateDirectory(projectDir), CONTEXT_PACK_FILENAME))
      ).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('fails open without fetching against an installed plugin cwd', async () => {
    const fetchImpl = vi.fn();
    await expect(
      hydrateContextPack({
        env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
        projectDir: 'relative/plugin-cache',
        fetchImpl,
      })
    ).resolves.toEqual({
      ok: true,
      skipped: 'project_directory_unavailable',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails open on offline and oversized context-pack responses', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    try {
      await expect(
        hydrateContextPack({
          env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
          projectDir,
          fetchImpl: vi.fn(async () => {
            throw new TypeError('offline');
          }),
        })
      ).resolves.toMatchObject({
        ok: true,
        skipped: 'context_pack_request_failed',
        reason: 'network_error',
        sessionContext: {
          activated: false,
          reason: 'context_refresh_failed',
          priorActivationCleared: false,
          clearReason: 'wizard_unavailable',
        },
      });

      await expect(
        hydrateContextPack({
          env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
          projectDir,
          fetchImpl: vi.fn(async () =>
            response({ padding: 'x'.repeat(MAX_CONTEXT_PACK_RESPONSE_BYTES) })
          ),
        })
      ).resolves.toMatchObject({
        ok: true,
        skipped: 'context_pack_response_too_large',
        sessionContext: {
          activated: false,
          reason: 'context_refresh_failed',
        },
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects a 200 response whose API envelope says ok false and clears stale state', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const privateDir = stateDirectory(projectDir);
    const packPath = join(privateDir, CONTEXT_PACK_FILENAME);
    const pendingPath = join(privateDir, PENDING_CONTEXT_FILENAME);
    const wizardCalls: Array<Record<string, unknown>> = [];
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(packPath, 'stale-pack');
    writeFileSync(pendingPath, 'stale-pending');
    try {
      const result = await hydrateContextPack({
        env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
        projectDir,
        fetchImpl: vi.fn(async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: 'denied',
              data: { sessionWorkContext },
            }),
            { status: 200 }
          )
        ),
        spawnImpl: wizardProcess(wizardCalls),
      });

      expect(result).toMatchObject({
        ok: true,
        skipped: 'context_pack_response_invalid',
        sessionContext: {
          activated: false,
          reason: 'context_refresh_failed',
          priorActivationCleared: true,
        },
      });
      expect(existsSync(packPath)).toBe(false);
      expect(existsSync(pendingPath)).toBe(false);
      expect(wizardCalls).toHaveLength(1);
      expect(wizardCalls[0].args).toEqual([
        'sessions',
        'context',
        'clear',
        '--cwd',
        projectDir,
        '--source-client',
        'opencode',
        '--session-id',
        'session-1',
        '--json',
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not spawn or persist a context above the Wizard ceiling', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const wizardCalls: Array<Record<string, unknown>> = [];
    try {
      const result = await hydrateContextPack({
        env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
        projectDir,
        fetchImpl: vi.fn(async () =>
          response({
            sessionWorkContext: {
              ...sessionWorkContext,
              padding: 'x'.repeat(5 * 1024),
            },
          })
        ),
        spawnImpl: wizardProcess(wizardCalls),
      });

      expect(result.sessionContext).toEqual({
        activated: false,
        reason: 'context_invalid',
        priorActivationCleared: true,
        clearReason: 'wizard_cleared',
      });
      expect((wizardCalls[0].args as string[])[2]).toBe('clear');
      expect(
        existsSync(join(stateDirectory(projectDir), PENDING_CONTEXT_FILENAME))
      ).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not accept exit zero without a valid exact-cwd Wizard acknowledgement', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    try {
      for (const output of [
        '{"ready":true}',
        (args: string[]) =>
          JSON.stringify({
            ackVersion: 'orgx-session-work-context-ack/v1',
            activationVersion: 'orgx-session-work-context-activation/v2',
            ready: true,
            state: 'ready',
            cwd: '/wrong/project',
            sourceClient: 'opencode',
            sessionId: 'session-1',
            contextSha256: args[args.indexOf('--context-sha256') + 1],
          }),
      ]) {
        const result = await hydrateContextPack({
          env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
          projectDir,
          fetchImpl: vi.fn(async () => response({ sessionWorkContext })),
          spawnImpl: wizardProcess([], 0, output),
        });
        expect(result.sessionContext?.activated).toBe(false);
        expect(['wizard_unverified', 'wizard_cwd_mismatch']).toContain(
          result.sessionContext?.reason
        );
        expect(result.sessionContext?.pendingPath).toBeTruthy();
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects a Wizard acknowledgement not bound to the exact session, source, digest, and contract', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const mutations = [
      { ackVersion: 'wrong' },
      { activationVersion: 'wrong' },
      { sourceClient: 'cursor' },
      { sessionId: 'another-session' },
      { contextSha256: '0'.repeat(64) },
    ];
    try {
      for (const mutation of mutations) {
        const wizardCalls: Array<Record<string, unknown>> = [];
        const result = await hydrateContextPack({
          env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
          projectDir,
          fetchImpl: vi.fn(async () => response({ sessionWorkContext })),
          spawnImpl: wizardProcess(wizardCalls, 0, (args) =>
            JSON.stringify(
              args.includes('clear')
                ? {
                    ackVersion: 'orgx-session-work-context-ack/v1',
                    ready: false,
                    state: 'missing',
                    cleared: true,
                    cwd: projectDir,
                    sourceClient: 'opencode',
                    sessionId: 'session-1',
                  }
                : {
                    ackVersion: 'orgx-session-work-context-ack/v1',
                    activationVersion:
                      'orgx-session-work-context-activation/v2',
                    ready: true,
                    state: 'ready',
                    cwd: projectDir,
                    sourceClient: 'opencode',
                    sessionId: 'session-1',
                    contextSha256: args[args.indexOf('--context-sha256') + 1],
                    ...mutation,
                  }
            )
          ),
        });
        expect(result.sessionContext).toMatchObject({
          activated: false,
          reason: 'wizard_unverified',
          priorActivationCleared: true,
          clearReason: 'wizard_cleared',
        });
        expect(result.sessionContext?.pendingPath).toBeTruthy();
        expect(
          wizardCalls.map((call) => (call.args as string[])[2])
        ).toEqual(['set', 'clear']);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('bounds Wizard output and keeps the exact context pending', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    try {
      const result = await hydrateContextPack({
        env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
        projectDir,
        fetchImpl: vi.fn(async () => response({ sessionWorkContext })),
        spawnImpl: wizardProcess([], 0, 'x'.repeat(MAX_WIZARD_OUTPUT_BYTES + 1)),
      });
      expect(result.sessionContext?.reason).toBe('wizard_output_too_large');
      expect(result.sessionContext?.pendingPath).toBeTruthy();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('clears prior cwd authority when the authoritative request is offline', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const pendingPath = join(stateDirectory(projectDir), PENDING_CONTEXT_FILENAME);
    mkdirSync(stateDirectory(projectDir), { recursive: true });
    writeFileSync(pendingPath, 'prior-context');
    const wizardCalls: Array<Record<string, unknown>> = [];
    const spawnImpl = wizardProcess(wizardCalls);
    try {
      const result = await hydrateContextPack({
        env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
        projectDir,
        fetchImpl: vi.fn(async () => {
          throw new TypeError('offline');
        }),
        spawnImpl,
      });
      expect(result.reason).toBe('network_error');
      expect(result.sessionContext).toEqual({
        activated: false,
        reason: 'context_refresh_failed',
        priorActivationCleared: true,
        clearReason: 'wizard_cleared',
      });
      expect(existsSync(pendingPath)).toBe(false);
      expect(wizardCalls[0].args).toEqual([
        'sessions',
        'context',
        'clear',
        '--cwd',
        projectDir,
        '--source-client',
        'opencode',
        '--session-id',
        'session-1',
        '--json',
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects a clear acknowledgement for a different native session', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    try {
      const result = await clearSessionWorkContext({
        projectDir,
        sessionId: 'session-1',
        spawnImpl: wizardProcess([], 0, (args) =>
          JSON.stringify({
            ackVersion: 'orgx-session-work-context-ack/v1',
            ready: false,
            state: 'missing',
            cleared: true,
            cwd: args[args.indexOf('--cwd') + 1],
            sourceClient: 'opencode',
            sessionId: 'another-session',
          })
        ),
      });

      expect(result).toEqual({ cleared: false, reason: 'wizard_unverified' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('replaces a destination symlink without overwriting its target', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const opencodeDir = stateDirectory(projectDir);
    const victimPath = join(projectDir, 'victim.json');
    const packPath = join(opencodeDir, CONTEXT_PACK_FILENAME);
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(victimPath, 'do-not-overwrite');
    symlinkSync(victimPath, packPath);
    try {
      const result = await hydrateContextPack({
        env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
        projectDir,
        fetchImpl: vi.fn(async () => response({ sessionWorkContext })),
        spawnImpl: wizardProcess([]),
      });
      expect(result.ok).toBe(true);
      expect(readFileSync(victimPath, 'utf8')).toBe('do-not-overwrite');
      expect(JSON.parse(readFileSync(packPath, 'utf8')).data).toBeTruthy();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked private state root without writing through it', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-outside-'));
    symlinkSync(outsideDir, testStateRoot(projectDir));
    try {
      const result = await hydrateContextPack({
        env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
        projectDir,
        fetchImpl: vi.fn(async () => response({ sessionWorkContext })),
        spawnImpl: wizardProcess([]),
      });
      expect(result).toMatchObject({
        ok: false,
        skipped: 'context_pack_hydration_failed',
      });
      expect(existsSync(join(outsideDir, CONTEXT_PACK_FILENAME))).toBe(false);
      expect(existsSync(join(outsideDir, PENDING_CONTEXT_FILENAME))).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects a state path whose existing symlink ancestor resolves into the project', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-context-pack-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'orgx-opencode-outside-'));
    const linkedProject = join(outsideDir, 'linked-project');
    const stateRoot = join(linkedProject, 'runtime-state');
    symlinkSync(projectDir, linkedProject);
    try {
      const result = await hydrateContextPackImpl({
        env: { ORGX_API_KEY: 'oxk_test', ORGX_TASK_ID: 'task-1' },
        projectDir,
        sessionId: 'session-1',
        stateRoot,
        fetchImpl: vi.fn(async () => response({ sessionWorkContext })),
        spawnImpl: wizardProcess([]),
      });

      expect(result).toMatchObject({
        ok: false,
        skipped: 'context_pack_hydration_failed',
      });
      expect(existsSync(join(projectDir, 'runtime-state'))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
