import type {
  Event as NativeEvent,
  OpencodeClient,
} from '@opencode-ai/sdk/v2';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OpenCodeDriver,
  resolveDispatchWorkScope,
  resolveSafeOpenCodeServerUrl,
} from './OpenCodeDriver';
import { ActivationAcceptanceBroker } from './activationAcceptance';
import {
  canonicalJsonSha256,
  sessionWorkContextSha256,
} from './contextPackHydration';

const PROJECT_DIR = '/work/repo';
const SERVER_URL = 'http://127.0.0.1:4096';

function executionAttribution(providerId: string | null = null) {
  return {
    provider: providerId === null
      ? 'other'
      : providerId.includes('anthropic')
      ? 'anthropic'
      : providerId.includes('openai')
        ? 'openai'
        : 'other',
    provider_id: providerId,
    source_sub_type: 'user_managed',
    observed_at: '2026-08-26T16:00:00.000Z',
  };
}

function activatedHydration() {
  return {
    ok: true,
    additionalContext: 'accepted exact-session OrgX context',
    sessionContext: {
      activated: true,
      reason: 'wizard_activated' as const,
    },
  };
}

function coreSessionActivation(workContext: Record<string, unknown>) {
  return {
    schema_version: 'orgx-session-activation/v1',
    scope: {
      workspace_id: 'workspace-1',
      initiative_id: 'initiative-1',
      workstream_id: 'workstream-1',
      task_id: 'task-1',
    },
    work_context: workContext,
    compaction: {
      compacted: false,
      summary_truncated: false,
      omitted_counts: {
        authoritative_decisions: 0,
        open_risks: 0,
        acceptance_criteria: 0,
        artifact_refs: 0,
        evidence_refs: 0,
        active_constraints: 0,
        pending_expectations: 0,
        applied_learnings: 0,
        recent_receipt_refs: 0,
      },
      source_capsule: {
        id: 'capsule-1',
        content_digest: `sha256:${'c'.repeat(64)}`,
        generated_at: '2026-08-26T15:00:00.000Z',
        projection_consistency: 'best_effort_multi_read',
        omitted_counts: {
          authoritative_decisions: 0,
          applied_learnings: 0,
          pending_expectations: 0,
          open_risks: 0,
          recent_receipt_refs: 0,
        },
        source_completeness: {
          authoritative_decisions: {
            status: 'complete',
            candidates_unvalidated: 0,
          },
          current_intent: {
            status: 'complete',
            candidates_unvalidated: 0,
          },
          recent_receipt_refs: {
            status: 'complete',
            candidates_unvalidated: 0,
          },
        },
      },
    },
  };
}

function activationSha256(workContext: Record<string, unknown>) {
  return `sha256:${canonicalJsonSha256(coreSessionActivation(workContext))}`;
}

function assistantInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'assistant-1',
    parentID: 'user-1',
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    modelID: 'claude-sonnet',
    providerID: 'anthropic',
    mode: 'build',
    agent: 'build',
    path: { cwd: PROJECT_DIR, root: PROJECT_DIR },
    cost: 0,
    tokens: {
      total: 3400,
      input: 1000,
      output: 2200,
      reasoning: 200,
      cache: { read: 0, write: 0 },
    },
    ...overrides,
  };
}

function completedToolPart() {
  return {
    id: 'part-tool-1',
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'read_file',
    state: {
      status: 'completed',
      input: {},
      output: 'private output must not be emitted',
      title: 'read billing.py',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function createSdkFixture({
  events = [],
  promptInfo = assistantInfo(),
  parts = [completedToolPart()],
  diffs = [
    {
      file: 'tests/billing.py',
      additions: 4,
      deletions: 2,
      status: 'modified' as const,
    },
  ],
  delayPrompt = false,
  promptBarrier,
  sessionProviderId,
}: {
  events?: NativeEvent[];
  promptInfo?: ReturnType<typeof assistantInfo>;
  parts?: unknown[];
  diffs?: Array<{
    file?: string;
    additions: number;
    deletions: number;
    status?: 'added' | 'deleted' | 'modified';
  }>;
  delayPrompt?: boolean;
  promptBarrier?: Promise<void>;
  sessionProviderId?: string | null;
} = {}) {
  const selectedProviderId =
    sessionProviderId === undefined ? promptInfo.providerID : sessionProviderId;
  const create = vi.fn(async () => ({
    data: {
      id: 'session-1',
      ...(selectedProviderId
        ? {
            model: {
              id: promptInfo.modelID,
              providerID: selectedProviderId,
            },
          }
        : {}),
    },
  }));
  const prompt = vi.fn(async () => {
    if (promptBarrier) await promptBarrier;
    if (delayPrompt) await new Promise<void>((done) => setTimeout(done, 0));
    return { data: { info: promptInfo, parts } };
  });
  const diff = vi.fn(async () => ({ data: diffs }));
  const abort = vi.fn(async () => ({ data: true }));
  const eventAbortSignals: AbortSignal[] = [];
  const subscribe = vi.fn(async (_parameters, options) => {
    if (options?.signal) eventAbortSignals.push(options.signal);
    return {
      stream: (async function* () {
        for (const event of events) yield event;
      })(),
    };
  });
  const client = {
    global: {
      health: vi.fn(async () => ({
        data: { healthy: true, version: '1.18.2' },
      })),
    },
    provider: {
      list: vi.fn(async () => ({
        data: { all: [], default: {}, connected: ['anthropic'] },
      })),
    },
    event: { subscribe },
    session: {
      status: vi.fn(async () => ({
        data: { 'session-1': { type: 'busy' } },
      })),
      create,
      prompt,
      diff,
      abort,
    },
  } as unknown as OpencodeClient;
  return {
    client,
    create,
    prompt,
    diff,
    abort,
    subscribe,
    eventAbortSignals,
  };
}

function driverWithFixture(
  fixture: ReturnType<typeof createSdkFixture>,
  overrides: ConstructorParameters<typeof OpenCodeDriver>[0] = {}
) {
  return new OpenCodeDriver({
    openCodeServerUrl: SERVER_URL,
    defaultDirectory: PROJECT_DIR,
    workspaceId: 'workspace-1',
    orgxApiKey: 'oxk_test_only',
    orgxBaseUrl: 'https://useorgx.com',
    createClient: vi.fn(() => fixture.client),
    hydrateContextPack: vi.fn(async () => activatedHydration()),
    clearSessionWorkContext: vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared',
    })),
    skillRules: async () => [],
    workGraphOutboxPath: false,
    ...overrides,
  });
}

async function collect(
  driver: OpenCodeDriver,
  task: Record<string, unknown>,
  context: Record<string, unknown> = {}
) {
  const messages: unknown[] = [];
  for await (const message of driver.dispatch(
    {
      title: 'parametrize billing tests',
      driver: 'opencode',
      execution_attribution: executionAttribution(),
      ...task,
    },
    { run_id: 'run-1', idempotency_key: 'key-1', ...context }
  )) {
    messages.push(message);
  }
  return messages;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OpenCodeDriver official SDK boundary', () => {
  it('detects health and provider connection through official SDK methods', async () => {
    const fixture = createSdkFixture();
    const createClient = vi.fn(() => fixture.client);
    const driver = driverWithFixture(fixture, { createClient });

    await expect(driver.detect()).resolves.toEqual({
      installed: true,
      authenticated: true,
      version: '1.18.2',
      subscription_active: true,
    });
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: SERVER_URL,
      redirect: 'error',
    });
    expect(fixture.client.global.health).toHaveBeenCalledOnce();
    expect(fixture.client.provider.list).toHaveBeenCalledOnce();
  });

  it('drives the installed SDK over its official session endpoints', async () => {
    const requests: Array<{ method: string; url: URL; body?: unknown; redirect: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.clone().json().catch(() => undefined) : undefined;
      requests.push({
        method: request.method,
        url,
        body,
        redirect: request.redirect,
      });
      if (request.method === 'POST' && url.pathname === '/session') {
        return new Response(JSON.stringify({
          id: 'session-1',
          model: { id: 'claude-sonnet', providerID: 'anthropic' },
        }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (request.method === 'GET' && url.pathname === '/event') {
        return new Response('', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/session/session-1/message'
      ) {
        return new Response(
          JSON.stringify({ info: assistantInfo(), parts: [] }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/session/session-1/diff'
      ) {
        return new Response(JSON.stringify([]), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    const driver = new OpenCodeDriver({
      openCodeServerUrl: SERVER_URL,
      defaultDirectory: PROJECT_DIR,
      workspaceId: 'workspace-1',
      orgxApiKey: 'oxk_test_only',
      orgxBaseUrl: 'https://useorgx.com',
      hydrateContextPack: vi.fn(async () => activatedHydration()),
      clearSessionWorkContext: vi.fn(async () => ({
        cleared: true,
        reason: 'wizard_cleared',
      })),
      workGraphOutboxPath: false,
    });

    const messages = await collect(driver, {});

    expect(messages.at(-1)).toMatchObject({ kind: 'task.completed' });
    expect(requests.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual(
      expect.arrayContaining([
        'POST /session',
        'GET /event',
        'POST /session/session-1/message',
        'GET /session/session-1/diff',
      ])
    );
    const prompt = requests.find(
      ({ method, url }) =>
        method === 'POST' && url.pathname === '/session/session-1/message'
    );
    expect(prompt?.body).toMatchObject({
      system: 'accepted exact-session OrgX context',
      parts: [{ type: 'text', text: 'parametrize billing tests' }],
    });
    expect(
      requests.find(({ url }) => url.pathname === '/session/session-1/diff')
        ?.url.searchParams.get('messageID')
    ).toBe('user-1');
    expect(requests.every(({ redirect }) => redirect === 'error')).toBe(true);
  });

  it('accepts only credential-free loopback server origins', () => {
    expect(resolveSafeOpenCodeServerUrl('http://localhost:4096/')).toBe(
      'http://localhost:4096'
    );
    expect(resolveSafeOpenCodeServerUrl('https://127.0.0.1:4096')).toBe(
      'https://127.0.0.1:4096'
    );
    expect(resolveSafeOpenCodeServerUrl('http://[::1]:4096')).toBe(
      'http://[::1]:4096'
    );
    expect(resolveSafeOpenCodeServerUrl('http://user:secret@localhost:4096')).toBeNull();
    expect(resolveSafeOpenCodeServerUrl('http://localhost:4096/path')).toBeNull();
    expect(resolveSafeOpenCodeServerUrl('https://example.com')).toBeNull();
  });

  it('creates, activates the returned session, then prompts with that context', async () => {
    const fixture = createSdkFixture();
    const hydrateContextPack = vi.fn(async () => activatedHydration());
    const driver = driverWithFixture(fixture, { hydrateContextPack });

    const messages = await collect(driver, {
      workspace_id: 'workspace-1',
      initiative_id: 'initiative-1',
      workstream_id: 'workstream-1',
      task_id: 'task-1',
      repo_path: PROJECT_DIR,
    });

    expect(fixture.create.mock.invocationCallOrder[0]).toBeLessThan(
      hydrateContextPack.mock.invocationCallOrder[0]
    );
    expect(hydrateContextPack.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.prompt.mock.invocationCallOrder[0]
    );
    expect(hydrateContextPack).toHaveBeenCalledWith({
      env: expect.objectContaining({
        ORGX_API_KEY: 'oxk_test_only',
        ORGX_BASE_URL: 'https://useorgx.com',
        ORGX_WORKSPACE_ID: 'workspace-1',
        ORGX_INITIATIVE_ID: 'initiative-1',
        ORGX_WORKSTREAM_ID: 'workstream-1',
        ORGX_TASK_ID: 'task-1',
      }),
      projectDir: PROJECT_DIR,
      sessionId: 'session-1',
    });
    expect(fixture.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: 'session-1',
        directory: PROJECT_DIR,
        system: 'accepted exact-session OrgX context',
      }),
      expect.objectContaining({ throwOnError: true, redirect: 'error' })
    );
    expect(fixture.diff).toHaveBeenCalledWith(
      expect.objectContaining({ messageID: 'user-1' }),
      expect.objectContaining({ throwOnError: true })
    );
    expect(messages.map((message) => (message as { kind: string }).kind)).toEqual([
      'task.started',
      'task.step',
      'task.step',
      'task.completed',
    ]);
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.completed',
      outcome_kind: 'awaiting_review',
      tokens_used: 3400,
      provider: 'anthropic',
      source_sub_type: 'user_managed',
    });
    expect(fixture.eventAbortSignals).toHaveLength(1);
    expect(fixture.eventAbortSignals[0].aborted).toBe(true);
  });

  it('binds and reports an OpenAI execution from official session and assistant fields', async () => {
    const fixture = createSdkFixture({
      promptInfo: assistantInfo({
        modelID: 'gpt-5',
        providerID: 'openai',
      }),
      parts: [],
      diffs: [],
    });
    const driver = driverWithFixture(fixture);

    const messages = await collect(driver, {
      repo_path: PROJECT_DIR,
      execution_attribution: executionAttribution('openai'),
    });

    expect(messages.at(-1)).toMatchObject({
      kind: 'task.completed',
      provider: 'openai',
      source_sub_type: 'user_managed',
    });
    expect(driver.executionProviderLease()).toMatchObject({
      provider: 'openai',
      providerId: 'openai',
    });
  });

  it('requires execution attribution before native session creation', async () => {
    const fixture = createSdkFixture();
    const messages = await collect(driverWithFixture(fixture), {
      execution_attribution: undefined,
      repo_path: PROJECT_DIR,
    });

    expect(fixture.create).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason: 'OrgX dispatch is missing execution attribution',
    });
  });

  it('rejects a non-null provider lease that disagrees with the native session', async () => {
    const fixture = createSdkFixture();
    const messages = await collect(driverWithFixture(fixture), {
      execution_attribution: executionAttribution('openai'),
      repo_path: PROJECT_DIR,
    });

    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason: 'OpenCode session provider does not match execution attribution',
    });
  });

  it('consumes the exact Gateway activation and acknowledges it before prompting', async () => {
    const fixture = createSdkFixture();
    const context = {
      schema_version: 'orgx-session-work-context/v1',
      provenance: 'producer_asserted',
      intent: {
        summary: 'Continue the accepted slice.',
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
    const digest = `sha256:${sessionWorkContextSha256(context)}`;
    const sessionActivation = coreSessionActivation(context);
    const activationDigest = `sha256:${canonicalJsonSha256(sessionActivation)}`;
    const activateProvidedSessionWorkContext = vi.fn(async () =>
      activatedHydration()
    );
    const hydrateContextPack = vi.fn(async () => activatedHydration());
    const awaitActivationAcceptance = vi.fn(async () => undefined);
    const driver = driverWithFixture(fixture, {
      activateProvidedSessionWorkContext,
      hydrateContextPack,
      awaitActivationAcceptance,
    });

    const messages = await collect(
      driver,
      {
        repo_path: PROJECT_DIR,
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: sessionActivation,
          context_sha256: digest,
          activation_sha256: activationDigest,
        },
      },
      { protocol_version: 1 }
    );

    expect(hydrateContextPack).not.toHaveBeenCalled();
    expect(activateProvidedSessionWorkContext).toHaveBeenCalledWith({
      context,
      activationEnvelope: sessionActivation,
      env: expect.objectContaining({
        ORGX_WORKSPACE_ID: 'workspace-1',
        ORGX_INITIATIVE_ID: 'initiative-1',
        ORGX_WORKSTREAM_ID: 'workstream-1',
        ORGX_TASK_ID: 'task-1',
      }),
      projectDir: PROJECT_DIR,
      sessionId: 'session-1',
    });
    expect(fixture.create.mock.invocationCallOrder[0]).toBeLessThan(
      activateProvidedSessionWorkContext.mock.invocationCallOrder[0]
    );
    expect(activateProvidedSessionWorkContext.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.prompt.mock.invocationCallOrder[0]
    );
    expect(awaitActivationAcceptance).toHaveBeenCalledWith({
      runId: 'run-1',
      contextSha256: digest,
      activationSha256: activationDigest,
      nativeSessionId: 'session-1',
    });
    expect(awaitActivationAcceptance.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.prompt.mock.invocationCallOrder[0]
    );
    expect(messages[0]).toMatchObject({
      kind: 'task.started',
      session_handle: 'session-1',
      context_activation_ack: {
        schema_version: 'orgx-gateway-session-context-activation-ack/v1',
        source_client: 'opencode',
        native_session_id: 'session-1',
        cwd: PROJECT_DIR,
        context_sha256: digest,
        activation_sha256: activationDigest,
      },
    });
    expect(
      (messages[0] as { context_activation_ack: { activated_at: string } })
        .context_activation_ack.activated_at
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('consumes the byte-equivalent core Gateway activation golden', async () => {
    const { readFile } = await import('node:fs/promises');
    const fixturePath = new URL(
      '../tests/fixtures/gatewaySessionContextActivation.v1.json',
      import.meta.url
    );
    const gatewayActivation = JSON.parse(
      await readFile(fixturePath, 'utf8')
    ) as {
      session_activation: {
        scope: { workspace_id: string };
        work_context: Record<string, unknown>;
      };
      context_sha256: `sha256:${string}`;
      activation_sha256: `sha256:${string}`;
    };
    expect(
      `sha256:${sessionWorkContextSha256(
        gatewayActivation.session_activation.work_context
      )}`
    ).toBe(
      'sha256:67bb73b5e76105a0fc86e6399cb1a90f2fc929ca8e0b7fee288782660ebc6601'
    );
    expect(
      `sha256:${canonicalJsonSha256(gatewayActivation.session_activation)}`
    ).toBe(
      'sha256:9fc9376b4a3112bb2e2b3ec46e044ca60a1832126545357df52a9abddb7815a8'
    );

    const fixture = createSdkFixture();
    const activateProvidedSessionWorkContext = vi.fn(async () =>
      activatedHydration()
    );
    const messages = await collect(
      driverWithFixture(fixture, {
        workspaceId: gatewayActivation.session_activation.scope.workspace_id,
        activateProvidedSessionWorkContext,
        awaitActivationAcceptance: vi.fn(async () => undefined),
      }),
      {
        repo_path: PROJECT_DIR,
        context_activation: gatewayActivation,
      },
      { protocol_version: 1 }
    );

    expect(activateProvidedSessionWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({
        context: gatewayActivation.session_activation.work_context,
        activationEnvelope: gatewayActivation.session_activation,
        projectDir: PROJECT_DIR,
        sessionId: 'session-1',
      })
    );
    expect(messages[0]).toMatchObject({
      kind: 'task.started',
      context_activation_ack: {
        context_sha256: gatewayActivation.context_sha256,
        activation_sha256: gatewayActivation.activation_sha256,
        cwd: PROJECT_DIR,
        native_session_id: 'session-1',
      },
    });
    expect(messages.at(-1)).toMatchObject({ kind: 'task.completed' });
  });

  it('does not prompt until the Gateway accepts the exact activation', async () => {
    const fixture = createSdkFixture();
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const digest = `sha256:${sessionWorkContextSha256(workContext)}`;
    let accept!: () => void;
    const awaitActivationAcceptance = vi.fn(
      () =>
        new Promise<void>((resolveAcceptance) => {
          accept = resolveAcceptance;
        })
    );
    const driver = driverWithFixture(fixture, {
      activateProvidedSessionWorkContext: vi.fn(async () => activatedHydration()),
      awaitActivationAcceptance,
    });
    const iterator = driver.dispatch(
      {
        title: 'wait for acceptance',
        driver: 'opencode',
        execution_attribution: executionAttribution(),
        repo_path: PROJECT_DIR,
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: digest,
          activation_sha256: activationSha256(workContext),
        },
      } as never,
      {
        run_id: 'run-1',
        idempotency_key: 'key-1',
        protocol_version: 1,
      }
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: 'task.started', session_handle: 'session-1' },
    });
    const afterStarted = iterator.next();
    await Promise.resolve();
    expect(fixture.prompt).not.toHaveBeenCalled();

    accept();
    await afterStarted;
    expect(fixture.prompt).toHaveBeenCalledOnce();
    await iterator.return?.();
  });

  it('retries the identical started acknowledgement after a lost acceptance frame and prompts once', async () => {
    const fixture = createSdkFixture({ parts: [], diffs: [] });
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const digest = `sha256:${sessionWorkContextSha256(workContext)}`;
    let accept!: () => void;
    const driver = driverWithFixture(fixture, {
      activateProvidedSessionWorkContext: vi.fn(async () => activatedHydration()),
      awaitActivationAcceptance: vi.fn(
        () =>
          new Promise<void>((resolveAcceptance) => {
            accept = resolveAcceptance;
          })
      ),
      activationAcceptanceRetryMs: 1,
    });
    const iterator = driver.dispatch(
      {
        title: 'retry exact activation',
        driver: 'opencode',
        execution_attribution: executionAttribution(),
        repo_path: PROJECT_DIR,
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: digest,
          activation_sha256: activationSha256(workContext),
        },
      } as never,
      {
        run_id: 'run-1',
        idempotency_key: 'key-1',
        protocol_version: 1,
      }
    )[Symbol.asyncIterator]();

    const first = await iterator.next();
    const retry = await iterator.next();
    expect(first.done).toBe(false);
    expect(retry.done).toBe(false);
    expect(retry.value).toEqual(first.value);
    expect(fixture.prompt).not.toHaveBeenCalled();

    accept();
    const remaining: unknown[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }

    expect(fixture.prompt).toHaveBeenCalledOnce();
    expect(remaining.at(-1)).toMatchObject({ kind: 'task.completed' });
  });

  it('times out without prompting and clears the exact activation lease', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const outbox = join(
      await mkdtemp(join(tmpdir(), 'ocd-acceptance-timeout-')),
      'events.jsonl'
    );
    const fixture = createSdkFixture();
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const broker = new ActivationAcceptanceBroker(8);
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared' as const,
    }));
    const messages = await collect(
      driverWithFixture(fixture, {
        activateProvidedSessionWorkContext: vi.fn(async () => activatedHydration()),
        awaitActivationAcceptance: (expectation) =>
          broker.waitForAcceptance(expectation),
        cancelActivationAcceptance: (runId) =>
          broker.rejectRun(runId, 'dispatch ended'),
        activationAcceptanceRetryMs: 2,
        clearSessionWorkContext,
        workGraphOutboxPath: outbox,
      }),
      {
        repo_path: PROJECT_DIR,
        execution_attribution: executionAttribution(),
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: `sha256:${sessionWorkContextSha256(workContext)}`,
          activation_sha256: activationSha256(workContext),
        },
      },
      { protocol_version: 1 }
    );

    const starts = messages.filter(
      (message) => (message as { kind: string }).kind === 'task.started'
    );
    expect(starts.length).toBeGreaterThan(1);
    expect(starts.every((message) => JSON.stringify(message) === JSON.stringify(starts[0]))).toBe(true);
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason: 'Timed out waiting for Gateway context activation acceptance',
    });
    expect(clearSessionWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' })
    );
    const events = (await readFile(outbox, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    expect(events).toContain('task_failed');
    expect(events).not.toContain('task_started');
  });

  it('fails and clears the exact lease when activation acceptance is rejected', async () => {
    const fixture = createSdkFixture();
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared' as const,
    }));
    const messages = await collect(
      driverWithFixture(fixture, {
        activateProvidedSessionWorkContext: vi.fn(async () => activatedHydration()),
        awaitActivationAcceptance: vi.fn(async () => {
          throw new Error('Gateway rejected OrgX context activation');
        }),
        clearSessionWorkContext,
      }),
      {
        repo_path: PROJECT_DIR,
        execution_attribution: executionAttribution(),
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: `sha256:${sessionWorkContextSha256(workContext)}`,
          activation_sha256: activationSha256(workContext),
        },
      },
      { protocol_version: 1 }
    );

    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(messages.map((message) => (message as { kind: string }).kind)).toEqual([
      'task.started',
      'task.failed',
    ]);
    expect(messages.at(-1)).toMatchObject({
      reason: 'Gateway rejected OrgX context activation',
    });
    expect(clearSessionWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: PROJECT_DIR,
        sessionId: 'session-1',
      })
    );
  });

  it('rejects relative task repo paths before creating a native session', async () => {
    const fixture = createSdkFixture();
    const messages = await collect(driverWithFixture(fixture), {
      repo_path: 'relative/repo',
    });

    expect(fixture.create).not.toHaveBeenCalled();
    expect(messages).toEqual([
      {
        kind: 'task.failed',
        run_id: 'run-1',
        reason: 'OrgX dispatch repo_path must be absolute',
        recoverable: false,
      },
    ]);
  });

  it('requires an explicit absolute repo path for Gateway activation', async () => {
    const fixture = createSdkFixture();
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const messages = await collect(
      driverWithFixture(fixture, {
        awaitActivationAcceptance: vi.fn(async () => undefined),
      }),
      {
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: `sha256:${sessionWorkContextSha256(workContext)}`,
          activation_sha256: activationSha256(workContext),
        },
      },
      { protocol_version: 1 }
    );

    expect(fixture.create).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason: 'OrgX context activation requires an absolute task repo_path',
    });
  });

  it('rejects a bad Gateway context digest without creating or prompting', async () => {
    const fixture = createSdkFixture();
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const messages = await collect(
      driverWithFixture(fixture),
      {
        repo_path: PROJECT_DIR,
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: `sha256:${'0'.repeat(64)}`,
          activation_sha256: activationSha256(workContext),
        },
      },
      { protocol_version: 1 }
    );

    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: 'task.failed',
      reason: 'OrgX dispatch context activation digest mismatch',
    });
  });

  it('rejects compaction tampering even when the work-context digest is unchanged', async () => {
    const fixture = createSdkFixture();
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const originalActivation = coreSessionActivation(workContext);
    const activationDigest = `sha256:${canonicalJsonSha256(originalActivation)}`;
    const tamperedActivation = structuredClone(originalActivation);
    tamperedActivation.compaction.source_capsule.id = 'tampered-capsule';
    const messages = await collect(
      driverWithFixture(fixture),
      {
        repo_path: PROJECT_DIR,
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: tamperedActivation,
          context_sha256: `sha256:${sessionWorkContextSha256(workContext)}`,
          activation_sha256: activationDigest,
        },
      },
      { protocol_version: 1 }
    );

    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason: 'OrgX dispatch session activation digest mismatch',
    });
  });

  it('rejects task-scoped activation without exact workstream lineage', async () => {
    const fixture = createSdkFixture();
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const sessionActivation = coreSessionActivation(workContext);
    delete (sessionActivation.scope as { workstream_id?: string }).workstream_id;
    const messages = await collect(
      driverWithFixture(fixture),
      {
        repo_path: PROJECT_DIR,
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: sessionActivation,
          context_sha256: `sha256:${sessionWorkContextSha256(workContext)}`,
          activation_sha256: `sha256:${canonicalJsonSha256(sessionActivation)}`,
        },
      },
      { protocol_version: 1 }
    );

    expect(fixture.create).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason: 'OrgX session activation hierarchy is invalid',
    });
  });

  it('fails a Gateway dispatch when the native session exposes no provider lease', async () => {
    const fixture = createSdkFixture({ sessionProviderId: null });
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const activateProvidedSessionWorkContext = vi.fn(async () =>
      activatedHydration()
    );
    const messages = await collect(
      driverWithFixture(fixture, {
        activateProvidedSessionWorkContext,
        awaitActivationAcceptance: vi.fn(async () => undefined),
      }),
      {
        repo_path: PROJECT_DIR,
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: `sha256:${sessionWorkContextSha256(workContext)}`,
          activation_sha256: activationSha256(workContext),
        },
      },
      { protocol_version: 1 }
    );

    expect(activateProvidedSessionWorkContext).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason: 'OpenCode session did not expose an authoritative provider lease',
    });
  });

  it('fails and clears authority when terminal provider disagrees with the session lease', async () => {
    const fixture = createSdkFixture({
      promptInfo: assistantInfo({ providerID: 'anthropic' }),
      sessionProviderId: 'openai',
    });
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared' as const,
    }));
    const messages = await collect(
      driverWithFixture(fixture, {
        activateProvidedSessionWorkContext: vi.fn(async () => activatedHydration()),
        awaitActivationAcceptance: vi.fn(async () => undefined),
        clearSessionWorkContext,
      }),
      {
        repo_path: PROJECT_DIR,
        execution_attribution: executionAttribution('openai'),
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: `sha256:${sessionWorkContextSha256(workContext)}`,
          activation_sha256: activationSha256(workContext),
        },
      },
      { protocol_version: 1 }
    );

    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason:
        'OpenCode terminal provider does not match the dispatch provider lease',
    });
    expect(clearSessionWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' })
    );
  });

  it('fails and clears authority when the terminal response belongs to another session', async () => {
    const fixture = createSdkFixture({
      promptInfo: assistantInfo({ sessionID: 'other-session' }),
    });
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared' as const,
    }));
    const messages = await collect(
      driverWithFixture(fixture, {
        activateProvidedSessionWorkContext: vi.fn(async () => activatedHydration()),
        awaitActivationAcceptance: vi.fn(async () => undefined),
        clearSessionWorkContext,
      }),
      {
        repo_path: PROJECT_DIR,
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: `sha256:${sessionWorkContextSha256(workContext)}`,
          activation_sha256: activationSha256(workContext),
        },
      },
      { protocol_version: 1 }
    );

    expect(fixture.diff).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason:
        'OpenCode terminal response does not match the dispatch session lease',
    });
    expect(clearSessionWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: PROJECT_DIR,
        sessionId: 'session-1',
      })
    );
  });

  it('fails before diff attribution when terminal evidence contains another session', async () => {
    const fixture = createSdkFixture({
      parts: [{ ...completedToolPart(), sessionID: 'other-session' }],
    });
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared' as const,
    }));
    const messages = await collect(
      driverWithFixture(fixture, {
        activateProvidedSessionWorkContext: vi.fn(async () => activatedHydration()),
        awaitActivationAcceptance: vi.fn(async () => undefined),
        clearSessionWorkContext,
      }),
      {
        repo_path: PROJECT_DIR,
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: `sha256:${sessionWorkContextSha256(workContext)}`,
          activation_sha256: activationSha256(workContext),
        },
      },
      { protocol_version: 1 }
    );

    expect(fixture.diff).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason: 'OpenCode terminal response contains cross-session evidence',
    });
    expect(clearSessionWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' })
    );
  });

  it('streams only events attributed to the exact native session', async () => {
    const event = (sessionID: string): NativeEvent =>
      ({
        id: `event-${sessionID}`,
        type: 'session.next.tool.called',
        properties: {
          timestamp: 1,
          sessionID,
          assistantMessageID: 'assistant-1',
          callID: `call-${sessionID}`,
          tool: 'bash',
          input: {},
          provider: { executed: true },
        },
      }) as NativeEvent;
    const fixture = createSdkFixture({
      events: [event('other-session'), event('session-1')],
      delayPrompt: true,
      parts: [],
      diffs: [],
    });
    const messages = await collect(driverWithFixture(fixture), {});
    const steps = messages.filter(
      (message) => (message as { kind: string }).kind === 'task.step'
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      step: { kind: 'tool_call', evidence_ref: 'call-session-1' },
    });
  });

  it('drops streamed parts whose nested session identity disagrees with the event', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const outbox = join(
      await mkdtemp(join(tmpdir(), 'ocd-mixed-session-stream-')),
      'events.jsonl'
    );
    const mixedSessionPart = {
      id: 'event-mixed-session',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { ...completedToolPart(), sessionID: 'other-session' },
      },
    } as NativeEvent;
    const fixture = createSdkFixture({
      events: [mixedSessionPart],
      parts: [],
      diffs: [],
      delayPrompt: true,
    });
    const messages = await collect(
      driverWithFixture(fixture, { workGraphOutboxPath: outbox }),
      {}
    );

    expect(
      messages.some(
        (message) => (message as { kind: string }).kind === 'task.step'
      )
    ).toBe(false);
    const events = (await readFile(outbox, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    expect(events).toEqual(['task_started', 'task_completed']);
  });

  it('fails closed and never prompts when exact-session activation is absent', async () => {
    const fixture = createSdkFixture();
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared' as const,
    }));
    const driver = driverWithFixture(fixture, {
      hydrateContextPack: vi.fn(async () => ({
        ok: true,
        skipped: 'context_pack_unconfigured' as const,
        sessionContext: {
          activated: false,
          reason: 'context_refresh_failed' as const,
        },
      })),
      clearSessionWorkContext,
    });

    const messages = await collect(driver, {});

    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      recoverable: false,
    });
    expect(clearSessionWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: PROJECT_DIR,
        sessionId: 'session-1',
      })
    );
  });

  it('treats a 200 assistant error as failure and clears its exact lease', async () => {
    const fixture = createSdkFixture({
      promptInfo: assistantInfo({
        error: { name: 'ProviderAuthError', data: { message: 'reauth required' } },
      }),
    });
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared' as const,
    }));
    const messages = await collect(
      driverWithFixture(fixture, { clearSessionWorkContext }),
      {}
    );

    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason: 'reauth required',
    });
    expect(clearSessionWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' })
    );
  });

  it('honors a cancellation received before dispatch without creating a native session', async () => {
    const fixture = createSdkFixture();
    const driver = driverWithFixture(fixture);

    await driver.cancel('run-1');
    const messages = await collect(driver, {});

    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(messages).toEqual([
      {
        kind: 'task.failed',
        run_id: 'run-1',
        reason: 'OpenCode dispatch was cancelled',
        recoverable: false,
      },
    ]);
  });

  it('clears authority re-established after cancellation during Wizard activation and never starts the task', async () => {
    const fixture = createSdkFixture();
    const workContext = {
      schema_version: 'orgx-session-work-context/v1',
    };
    let resolveActivation!: (value: ReturnType<typeof activatedHydration>) => void;
    const activateProvidedSessionWorkContext = vi.fn(
      () =>
        new Promise<ReturnType<typeof activatedHydration>>((resolve) => {
          resolveActivation = resolve;
        })
    );
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared' as const,
    }));
    const driver = driverWithFixture(fixture, {
      activateProvidedSessionWorkContext,
      clearSessionWorkContext,
      awaitActivationAcceptance: vi.fn(async () => undefined),
    });
    const collecting = collect(
      driver,
      {
        repo_path: PROJECT_DIR,
        context_activation: {
          schema_version: 'orgx-gateway-session-context-activation/v1',
          source_client: 'opencode',
          session_activation: coreSessionActivation(workContext),
          context_sha256: `sha256:${sessionWorkContextSha256(workContext)}`,
          activation_sha256: activationSha256(workContext),
        },
      },
      { run_id: 'run-cancel-activation', protocol_version: 1 }
    );

    await vi.waitFor(() => {
      expect(activateProvidedSessionWorkContext).toHaveBeenCalledOnce();
    });
    await driver.cancel('run-cancel-activation');
    expect(clearSessionWorkContext).toHaveBeenCalledOnce();

    resolveActivation(activatedHydration());
    const messages = await collecting;

    expect(fixture.abort).toHaveBeenCalledWith(
      { sessionID: 'session-1', directory: PROJECT_DIR },
      expect.objectContaining({ throwOnError: true, redirect: 'error' })
    );
    expect(clearSessionWorkContext).toHaveBeenCalledTimes(2);
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(
      messages.some(
        (message) => (message as { kind: string }).kind === 'task.started'
      )
    ).toBe(false);
    expect(messages.at(-1)).toMatchObject({
      kind: 'task.failed',
      reason: 'OpenCode dispatch was cancelled',
    });
  });

  it('terminates cancellation when the event stream ends but the prompt remains pending', async () => {
    const promptBarrier = new Promise<void>(() => undefined);
    const fixture = createSdkFixture({
      parts: [],
      diffs: [],
      promptBarrier,
    });
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared' as const,
    }));
    const driver = driverWithFixture(fixture, { clearSessionWorkContext });
    const iterator = driver.dispatch(
      {
        title: 'cancel pending prompt',
        driver: 'opencode',
        execution_attribution: executionAttribution(),
      } as never,
      { run_id: 'run-cancel-prompt', idempotency_key: 'key-cancel-prompt' }
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: 'task.started', session_handle: 'session-1' },
    });
    const pending = iterator.next();
    await vi.waitFor(() => expect(fixture.prompt).toHaveBeenCalledOnce());

    await driver.cancel('run-cancel-prompt');
    await expect(pending).resolves.toMatchObject({
      value: {
        kind: 'task.failed',
        reason: 'OpenCode dispatch was cancelled',
      },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(clearSessionWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' })
    );
    expect(fixture.diff).not.toHaveBeenCalled();
  });

  it('cancels and clears only the session mapped to the run', async () => {
    const fixture = createSdkFixture();
    const clearSessionWorkContext = vi.fn(async () => ({
      cleared: true,
      reason: 'wizard_cleared' as const,
    }));
    const driver = driverWithFixture(fixture, { clearSessionWorkContext });
    const iterator = driver.dispatch(
      {
        title: 'cancel me',
        driver: 'opencode',
        execution_attribution: executionAttribution(),
      } as never,
      { run_id: 'run-cancel', idempotency_key: 'key-cancel' }
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: 'task.started', session_handle: 'session-1' },
    });
    await driver.cancel('unmapped-run');
    expect(fixture.abort).not.toHaveBeenCalled();
    await driver.cancel('run-cancel');
    expect(fixture.abort).toHaveBeenCalledWith(
      { sessionID: 'session-1', directory: PROJECT_DIR },
      expect.objectContaining({ throwOnError: true, redirect: 'error' })
    );
    expect(clearSessionWorkContext).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' })
    );
    await iterator.return?.();
  });
});

describe('OpenCodeDriver scope and receipts', () => {
  it('prefers v2 workRef, accepts runtime task scope, and rejects disagreement', () => {
    expect(
      resolveDispatchWorkScope(
        { title: 'x', driver: 'opencode', workspace_id: 'workspace-1' },
        undefined,
        'workspace-1'
      )
    ).toEqual({
      workspaceId: 'workspace-1',
      initiativeId: undefined,
      workstreamId: undefined,
      taskId: undefined,
    });
    expect(
      resolveDispatchWorkScope(
        { title: 'x', driver: 'opencode' },
        {
          workRef: {
            workspaceId: 'workspace-1',
            initiativeId: 'initiative-1',
            workstreamId: 'workstream-1',
            taskId: 'task-1',
          },
        } as never,
        'workspace-1'
      )
    ).toMatchObject({ taskId: 'task-1', workstreamId: 'workstream-1' });
    expect(() =>
      resolveDispatchWorkScope(
        { title: 'x', driver: 'opencode', workspace_id: 'workspace-wrong' },
        { workRef: { workspaceId: 'workspace-1' } } as never,
        'workspace-1'
      )
    ).toThrow('workspaceId mismatch');
    expect(() =>
      resolveDispatchWorkScope(
        {
          title: 'x',
          driver: 'opencode',
          workspace_id: 'workspace-1',
          workstream_id: 'workstream-orphan',
        },
        undefined,
        'workspace-1'
      )
    ).toThrow('workstream scope requires an initiative');
    expect(() =>
      resolveDispatchWorkScope(
        {
          title: 'x',
          driver: 'opencode',
          workspace_id: 'workspace-1',
          initiative_id: 'initiative-1',
          task_id: 'task-without-workstream',
        },
        undefined,
        'workspace-1'
      )
    ).toThrow('task scope requires an initiative and workstream');
    expect(() =>
      resolveDispatchWorkScope(
        {
          title: 'x',
          driver: 'opencode',
          workspace_id: 42 as never,
        },
        undefined,
        'workspace-1'
      )
    ).toThrow('workspace_id is invalid');
  });

  it('spools compact Work Graph events without raw prompt or tool output', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const outbox = join(await mkdtemp(join(tmpdir(), 'ocd-work-graph-')), 'events.jsonl');
    const fixture = createSdkFixture();
    const driver = driverWithFixture(fixture, { workGraphOutboxPath: outbox });

    await collect(driver, {
      description: 'private task details',
      repo_path: PROJECT_DIR,
    });

    const records = (await readFile(outbox, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.event)).toEqual([
      'task_started',
      'task_step',
      'task_step',
      'task_completed',
    ]);
    expect(records[0]).toMatchObject({
      source: 'orgx_opencode_plugin_runtime_hook',
      source_client: 'opencode',
      run_id: 'run-1',
      session_id: 'session-1',
      cwd: PROJECT_DIR,
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('private task details');
    expect(serialized).not.toContain('private output must not be emitted');
  });

  it('emits one deviation for a matching official diff and replays terminal state', async () => {
    const fixture = createSdkFixture();
    const replayWorkGraph = vi.fn(async () => undefined);
    const messages = await collect(
      driverWithFixture(fixture, {
        replayWorkGraph,
        skillRules: async () => [
          {
            skill_id: 'billing-tests',
            match: { pattern: 'billing', on: 'file_edit' },
            dedupe_fingerprint: 'billing-v1',
            evidence_kind: 'test_change',
          },
        ],
      }),
      {}
    );

    expect(
      messages.filter(
        (message) => (message as { kind: string }).kind === 'task.deviation'
      )
    ).toHaveLength(1);
    expect(replayWorkGraph).toHaveBeenCalledOnce();
  });
});
