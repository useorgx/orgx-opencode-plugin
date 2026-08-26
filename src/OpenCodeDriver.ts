/**
 * OpenCode task driver backed only by the installed official v2 SDK.
 *
 * Each dispatch creates one native session, activates an exact-session OrgX
 * context lease, then sends the first prompt. Native events provide live
 * progress; the terminal prompt response and official diff endpoint provide
 * the deterministic completion summary.
 */

import { promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createOpencodeClient,
  type Event as NativeEvent,
  type OpencodeClient,
  type Part,
  type SnapshotFileDiff,
} from '@opencode-ai/sdk/v2';
import type {
  DispatchableTask,
  Driver,
  DriverOutboundMessage,
  DriverProbe,
  DriverStatus,
  ExecutionEnvelope,
  ProtocolVersion,
} from '@useorgx/orgx-gateway-sdk';

import {
  MAX_ADDITIONAL_CONTEXT_BYTES,
  MAX_SESSION_WORK_CONTEXT_BYTES,
  activateProvidedSessionWorkContext,
  canonicalJsonSha256,
  clearSessionWorkContext,
  hydrateContextPack,
  sessionWorkContextSha256,
  type ContextPackHydrationResult,
  type SessionContextClearance,
} from './contextPackHydration.js';
import { capturePluginException } from './sentry.js';
import {
  blockRuntimeSessionHydration,
  publishRuntimeSessionHydration,
} from './runtimeSessionContext.js';
import { recordWorkGraphEvent } from './workGraphOutbox.js';
import type { ActivationAcceptanceExpectation } from './activationAcceptance.js';
import { normalizeAbsoluteHostPath } from './hostPath.js';

type Env = Record<string, string | undefined>;
type DriverContext = {
  run_id: string;
  idempotency_key: string;
  protocol_version?: ProtocolVersion;
  execution_envelope?: ExecutionEnvelope;
};
type ScopedTask = DispatchableTask & {
  workspace_id?: string;
  initiative_id?: string;
  workstream_id?: string;
  task_id?: string;
  context_activation?: unknown;
  execution_attribution?: unknown;
};
type GatewayContextActivation = {
  sessionActivation: Record<string, unknown>;
  workContext: Record<string, unknown>;
  scope: WorkScope;
  contextSha256: `sha256:${string}`;
  activationSha256: `sha256:${string}`;
};
type ContextActivationAck = {
  schema_version: 'orgx-gateway-session-context-activation-ack/v1';
  source_client: 'opencode';
  native_session_id: string;
  cwd: string;
  context_sha256: `sha256:${string}`;
  activation_sha256: `sha256:${string}`;
  activated_at: string;
};
type WorkScope = {
  workspaceId: string;
  initiativeId?: string;
  workstreamId?: string;
  taskId?: string;
};
type GatewayExecutionAttribution = {
  provider: 'anthropic' | 'openai' | 'other';
  providerId: string | null;
  sourceSubType: 'user_managed';
  observedAt: string;
};
type OpenCodeEvent =
  | { kind: 'tool_call'; tool: string; summary: string; ref?: string }
  | { kind: 'file_edit'; path: string; summary: string; diff_ref?: string }
  | { kind: 'chat' }
  | { kind: 'assistant_completed'; tokens_used: number; provider: string };
type SkillRule = {
  skill_id: string;
  match: { pattern: string; on: 'file_edit' | 'tool_call' };
  dedupe_fingerprint: string;
  evidence_kind: string;
};
type ActiveRun = {
  client: OpencodeClient;
  cancellation: AbortController;
  directory: string;
  env: Env;
  providerLease?: ProviderLease;
  sessionId: string;
};
type ProviderLease = {
  provider: 'anthropic' | 'openai' | 'other';
  providerId: string;
  observedAt: string;
};
type ActivationAcceptanceOutcome =
  | { kind: 'accepted' }
  | { kind: 'rejected'; error: unknown };

const DEFAULT_ACTIVATION_RETRY_MS = 500;
const MAX_ACTIVATION_RETRY_MS = 5_000;
const MAX_CANCELLED_RUN_TOMBSTONES = 1_000;
const CANCELLED_DISPATCH_REASON = 'OpenCode dispatch was cancelled';

export type OpenCodeDriverOptions = {
  /** Native OpenCode server URL supplied by the plugin runtime. */
  openCodeServerUrl?: string;
  /** Native project directory supplied by the plugin runtime. */
  defaultDirectory?: string;
  /** Legacy CLI-only port discovery fallback. */
  statePath?: string;
  /** Official SDK factory override for tests. */
  createClient?: typeof createOpencodeClient;
  skillRules?: () => Promise<SkillRule[]>;
  workGraphOutboxPath?: string | false;
  sourceClient?: string;
  replayWorkGraph?: () => Promise<void>;
  hydrateContextPack?: typeof hydrateContextPack;
  activateProvidedSessionWorkContext?: typeof activateProvidedSessionWorkContext;
  clearSessionWorkContext?: typeof clearSessionWorkContext;
  orgxApiKey?: string;
  orgxBaseUrl?: string;
  workspaceId?: string;
  orgxEnv?: Env;
  awaitActivationAcceptance?: (
    expectation: ActivationAcceptanceExpectation
  ) => Promise<void>;
  cancelActivationAcceptance?: (runId: string) => void;
  activationAcceptanceRetryMs?: number;
};

export class OpenCodeDriver implements Driver {
  readonly id = 'opencode' as const;

  private baseUrlCache: string | null = null;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly cancelledRuns = new Set<string>();
  private latestProviderLease: ProviderLease | null = null;

  constructor(private readonly opts: OpenCodeDriverOptions = {}) {}

  /** Latest provider selected by OpenCode's official Session.model field. */
  executionProviderLease(): ProviderLease | null {
    return this.latestProviderLease ? { ...this.latestProviderLease } : null;
  }

  async detect(): Promise<DriverStatus> {
    try {
      const client = await this.client();
      const [health, providers] = await Promise.all([
        client.global.health({ throwOnError: true, redirect: 'error' }),
        client.provider.list(undefined, {
          throwOnError: true,
          redirect: 'error',
        }),
      ]);
      const authenticated = providers.data.connected.length > 0;
      return {
        installed: health.data.healthy === true,
        authenticated,
        version: health.data.version,
        subscription_active: authenticated,
      };
    } catch (error) {
      return {
        installed: false,
        authenticated: false,
        error: safeErrorMessage(error),
      };
    }
  }

  async probe(): Promise<DriverProbe> {
    try {
      const client = await this.client();
      const [health, providers, statuses] = await Promise.all([
        client.global.health({ throwOnError: true, redirect: 'error' }),
        client.provider.list(undefined, {
          throwOnError: true,
          redirect: 'error',
        }),
        client.session.status(undefined, {
          throwOnError: true,
          redirect: 'error',
        }),
      ]);
      const active = Object.values(statuses.data).filter(
        (status) => status.type !== 'idle'
      ).length;
      return {
        subscription_active:
          health.data.healthy === true && providers.data.connected.length > 0,
        session_alive: health.data.healthy === true,
        queue_depth: active,
      };
    } catch {
      return { subscription_active: false, session_alive: false };
    }
  }

  async *dispatch(
    task: DispatchableTask,
    context: DriverContext
  ): AsyncIterable<DriverOutboundMessage> {
    if (
      context.protocol_version !== undefined &&
      context.protocol_version !== 1
    ) {
      yield {
        kind: 'task.failed',
        run_id: context.run_id,
        reason:
          'OpenCode proof-bearing Gateway protocol v2 finalization is not supported',
        recoverable: false,
      };
      return;
    }
    const normalizedRepoPath =
      task.repo_path === undefined
        ? null
        : normalizeAbsoluteHostPath(task.repo_path);
    if (task.repo_path !== undefined && !normalizedRepoPath) {
      yield {
        kind: 'task.failed',
        run_id: context.run_id,
        reason: 'OrgX dispatch repo_path must be absolute',
        recoverable: false,
      };
      return;
    }
    const directory = resolve(
      normalizedRepoPath ?? this.opts.defaultDirectory ?? process.cwd()
    );
    let active: ActiveRun | undefined;
    let startedAt = new Date().toISOString();
    let activationWaitArmed = false;
    let activationAccepted = false;
    try {
      this.assertNotCancelled(context.run_id);
      const scopedTask = task as ScopedTask;
      const executionAttribution = parseGatewayExecutionAttribution(
        scopedTask.execution_attribution
      );
      const providedActivation = parseGatewayContextActivation(
        scopedTask.context_activation
      );
      if (providedActivation && task.repo_path === undefined) {
        throw new Error(
          'OrgX context activation requires an absolute task repo_path'
        );
      }
      let scope = resolveDispatchWorkScope(
        scopedTask,
        context.execution_envelope,
        this.opts.workspaceId
      );
      if (providedActivation) {
        scope = reconcileActivationScope(scope, providedActivation.scope);
      }
      const client = await this.client(directory);
      this.assertNotCancelled(context.run_id);
      const created = await client.session.create(
        { directory, title: task.title },
        { throwOnError: true, redirect: 'error' }
      );
      const sessionId = normalizedId(created.data.id, 'native session ID');
      const env = this.hydrationEnv(scope);
      active = {
        client,
        cancellation: new AbortController(),
        directory,
        env,
        sessionId,
      };
      this.activeRuns.set(context.run_id, active);
      this.assertNotCancelled(context.run_id);
      const providerLease = readProviderLease(created.data.model?.providerID);
      if (!providerLease) {
        throw new Error(
          'OpenCode session did not expose an authoritative provider lease'
        );
      }
      if (
        executionAttribution.providerId !== null &&
        (providerLease.providerId !== executionAttribution.providerId ||
          providerLease.provider !== executionAttribution.provider)
      ) {
        throw new Error(
          'OpenCode session provider does not match execution attribution'
        );
      }
      if (providerLease) this.latestProviderLease = providerLease;
      active.providerLease = providerLease;

      const hydration = providedActivation
        ? await (
            this.opts.activateProvidedSessionWorkContext ??
            activateProvidedSessionWorkContext
          )({
            context: providedActivation.workContext,
            activationEnvelope: providedActivation.sessionActivation,
            env,
            projectDir: directory,
            sessionId,
          })
        : await (this.opts.hydrateContextPack ?? hydrateContextPack)({
            env,
            projectDir: directory,
            sessionId,
          });
      this.assertNotCancelled(context.run_id);
      const system = verifiedAdditionalContext(hydration);
      publishRuntimeSessionHydration(directory, sessionId, hydration);
      startedAt = new Date().toISOString();
      const contextActivationAck: ContextActivationAck | undefined =
        providedActivation
          ? {
              schema_version:
                'orgx-gateway-session-context-activation-ack/v1',
              source_client: 'opencode',
              native_session_id: sessionId,
              cwd: directory,
              context_sha256: providedActivation.contextSha256,
              activation_sha256: providedActivation.activationSha256,
              activated_at: startedAt,
            }
          : undefined;
      const startedMessage = {
        kind: 'task.started',
        run_id: context.run_id,
        started_at: startedAt,
        session_handle: sessionId,
        ...(contextActivationAck
          ? { context_activation_ack: contextActivationAck }
          : {}),
      };
      let activationAcceptance: Promise<ActivationAcceptanceOutcome> | undefined;
      if (contextActivationAck) {
        if (!this.opts.awaitActivationAcceptance) {
          throw new Error(
            'Gateway context activation acceptance channel is unavailable'
          );
        }
        activationAcceptance = this.opts
          .awaitActivationAcceptance({
            runId: context.run_id,
            contextSha256: contextActivationAck.context_sha256,
            activationSha256: contextActivationAck.activation_sha256,
            nativeSessionId: sessionId,
          })
          .then(
            () => ({ kind: 'accepted' as const }),
            (error: unknown) => ({ kind: 'rejected' as const, error })
          );
        activationWaitArmed = true;
      }
      this.assertNotCancelled(context.run_id);
      yield startedMessage as DriverOutboundMessage;
      this.assertNotCancelled(context.run_id);
      if (activationAcceptance) {
        for await (const retry of retryStartedUntilAccepted(
          activationAcceptance,
          startedMessage as DriverOutboundMessage,
          this.opts.activationAcceptanceRetryMs
        )) {
          yield retry;
        }
        activationAccepted = true;
      }
      this.assertNotCancelled(context.run_id);
      await this.recordWorkGraph('task_started', task, context, {
        sessionHandle: sessionId,
        timestamp: startedAt,
        context_activation_acknowledged: Boolean(contextActivationAck),
        context_sha256: contextActivationAck?.context_sha256,
        activation_sha256: contextActivationAck?.activation_sha256,
        task_title_chars: task.title.length,
        description_chars: task.description?.length ?? 0,
        skill_count: task.skill_ids?.length ?? 0,
      });
      this.assertNotCancelled(context.run_id);
      const rules = await (this.opts.skillRules?.() ?? Promise.resolve([]));
      this.assertNotCancelled(context.run_id);
      const seenEvidence = new Set<string>();
      const seenDeviations = new Set<string>();
      let firstResponseAt: string | null = null;

      for await (const event of this.runPrompt(
        active,
        context.run_id,
        renderPrompt(task),
        system,
        seenEvidence
      )) {
        this.assertNotCancelled(context.run_id);
        if (!firstResponseAt && event.kind !== 'assistant_completed') {
          firstResponseAt = new Date().toISOString();
        }
        if (event.kind === 'assistant_completed') {
          await this.recordWorkGraph('task_completed', task, context, {
            sessionHandle: sessionId,
            tokens_used: event.tokens_used,
            first_response_seen: Boolean(firstResponseAt),
          });
          this.assertNotCancelled(context.run_id);
          yield {
            kind: 'task.completed',
            run_id: context.run_id,
            // A completed model turn is not proof that OrgX accepted or shipped it.
            outcome_kind: 'awaiting_review',
            started_at: startedAt,
            first_response_at: firstResponseAt ?? startedAt,
            completed_at: new Date().toISOString(),
            tokens_used: event.tokens_used,
            provider: providerKind(event.provider),
            source_sub_type: executionAttribution.sourceSubType,
            source_driver: 'opencode',
            cost_estimate_cents: 0,
          };
          await this.replayWorkGraph();
          return;
        }
        if (event.kind === 'chat') continue;
        yield* this.progressMessages(
          event,
          rules,
          seenDeviations,
          task,
          context,
          sessionId
        );
      }
      throw new Error('OpenCode prompt ended without a terminal response');
    } catch (error) {
      if (active) {
        if (
          this.cancelledRuns.has(context.run_id) &&
          !active.cancellation.signal.aborted
        ) {
          active.cancellation.abort();
          await this.abortNativeSession(active);
        }
        blockRuntimeSessionHydration(active.directory, active.sessionId);
        await this.clearAuthority(active);
      }
      const reason = safeErrorMessage(error);
      await this.recordWorkGraph('task_failed', task, context, {
        sessionHandle: active?.sessionId,
        recoverable: false,
        reason_chars: reason.length,
      });
      yield {
        kind: 'task.failed',
        run_id: context.run_id,
        reason,
        recoverable: false,
      };
      await this.replayWorkGraph();
    } finally {
      if (activationWaitArmed && !activationAccepted) {
        this.opts.cancelActivationAcceptance?.(context.run_id);
      }
      if (active && this.activeRuns.get(context.run_id) === active) {
        this.activeRuns.delete(context.run_id);
      }
      this.cancelledRuns.delete(context.run_id);
    }
  }

  async cancel(runId: string): Promise<void> {
    this.rememberCancellation(runId);
    this.opts.cancelActivationAcceptance?.(runId);
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.cancellation.abort();
    await this.abortNativeSession(active);
    blockRuntimeSessionHydration(active.directory, active.sessionId);
    await this.clearAuthority(active);
  }

  private async *runPrompt(
    active: ActiveRun,
    runId: string,
    prompt: string,
    system: string,
    seenEvidence: Set<string>
  ): AsyncGenerator<OpenCodeEvent> {
    this.assertNotCancelled(runId);
    const controller = new AbortController();
    const onCancelled = () => controller.abort();
    active.cancellation.signal.addEventListener('abort', onCancelled, {
      once: true,
    });
    const subscription = await active.client.event.subscribe(
      { directory: active.directory },
      {
        signal: controller.signal,
        redirect: 'error',
        sseMaxRetryAttempts: 1,
      }
    );
    this.assertNotCancelled(runId);
    const iterator = subscription.stream[Symbol.asyncIterator]();
    const promptResult = active.client.session
      .prompt(
        {
          sessionID: active.sessionId,
          directory: active.directory,
          system,
          parts: [{ type: 'text', text: prompt }],
        },
        { throwOnError: true, redirect: 'error' }
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
    let nextEvent:
      | Promise<
          | { ok: true; value: IteratorResult<NativeEvent> }
          | { ok: false; error: unknown }
        >
      | undefined = iterator.next().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    const cancellation = new Promise<{ source: 'cancel' }>((resolveCancel) => {
      if (active.cancellation.signal.aborted) {
        resolveCancel({ source: 'cancel' });
        return;
      }
      active.cancellation.signal.addEventListener(
        'abort',
        () => resolveCancel({ source: 'cancel' }),
        { once: true }
      );
    });
    let terminal: Awaited<typeof promptResult> | undefined;
    try {
      while (!terminal) {
        if (!nextEvent) {
          const result = await Promise.race([
            promptResult.then((value) => ({
              source: 'prompt' as const,
              value,
            })),
            cancellation,
          ]);
          if (result.source === 'cancel') {
            throw new Error(CANCELLED_DISPATCH_REASON);
          }
          terminal = result.value;
          break;
        }
        const result = await Promise.race([
          promptResult.then((value) => ({ source: 'prompt' as const, value })),
          nextEvent.then((value) => ({ source: 'event' as const, value })),
          cancellation,
        ]);
        if (result.source === 'cancel') {
          throw new Error(CANCELLED_DISPATCH_REASON);
        }
        if (result.source === 'prompt') {
          terminal = result.value;
          break;
        }
        if (!result.value.ok || result.value.value.done) {
          nextEvent = undefined;
          continue;
        }
        this.assertNotCancelled(runId);
        for (const event of mapNativeEvent(
          result.value.value.value,
          active.sessionId,
          seenEvidence
        )) {
          yield event;
        }
        nextEvent = iterator.next().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error })
        );
      }
    } finally {
      controller.abort();
      active.cancellation.signal.removeEventListener('abort', onCancelled);
      await iterator.return?.().catch(() => undefined);
    }
    this.assertNotCancelled(runId);
    if (!terminal?.ok) throw terminal?.error ?? new Error('OpenCode prompt failed');
    const response = terminal.value.data;
    if (response.info.error) throw new Error(messageError(response.info.error));
    const terminalSessionId = normalizedId(
      response.info.sessionID,
      'terminal session ID'
    );
    if (terminalSessionId !== active.sessionId) {
      throw new Error(
        'OpenCode terminal response does not match the dispatch session lease'
      );
    }
    if (response.parts.some((part) => part.sessionID !== active.sessionId)) {
      throw new Error(
        'OpenCode terminal response contains cross-session evidence'
      );
    }
    const terminalProviderId = normalizedId(
      response.info.providerID,
      'terminal provider ID'
    );
    if (
      active.providerLease &&
      terminalProviderId !== active.providerLease.providerId
    ) {
      throw new Error(
        'OpenCode terminal provider does not match the dispatch provider lease'
      );
    }
    for (const event of mapTerminalParts(response.parts, seenEvidence)) yield event;
    this.assertNotCancelled(runId);
    const diff = await active.client.session.diff(
      {
        sessionID: active.sessionId,
        directory: active.directory,
        messageID: response.info.parentID,
      },
      { throwOnError: true, redirect: 'error' }
    );
    this.assertNotCancelled(runId);
    for (const event of mapDiffs(diff.data, seenEvidence)) yield event;
    yield {
      kind: 'assistant_completed',
      tokens_used:
        response.info.tokens.total ??
        response.info.tokens.input +
          response.info.tokens.output +
          response.info.tokens.reasoning,
      provider: terminalProviderId,
    };
  }

  private async *progressMessages(
    event: Extract<OpenCodeEvent, { kind: 'file_edit' | 'tool_call' }>,
    rules: SkillRule[],
    seenDeviations: Set<string>,
    task: DispatchableTask,
    context: DriverContext,
    sessionId: string
  ): AsyncGenerator<DriverOutboundMessage> {
    const summary =
      event.kind === 'file_edit'
        ? `edit ${event.path} — ${event.summary}`
        : `call ${event.tool} — ${event.summary}`;
    const evidenceRef =
      event.kind === 'file_edit'
        ? event.diff_ref ?? event.path
        : event.ref ?? event.tool;
    await this.recordWorkGraph('task_step', task, context, {
      sessionHandle: sessionId,
      step_kind: event.kind,
      evidence_ref: evidenceRef,
      summary_chars: summary.length,
    });
    this.assertNotCancelled(context.run_id);
    yield {
      kind: 'task.step',
      run_id: context.run_id,
      step: { kind: event.kind, summary, evidence_ref: evidenceRef },
    };
    for (const rule of rules) {
      if (rule.match.on !== event.kind) continue;
      const text =
        event.kind === 'file_edit'
          ? `${event.path} ${event.summary}`
          : `${event.tool} ${event.summary}`;
      let matches = false;
      try {
        matches = new RegExp(rule.match.pattern).test(text);
      } catch {
        continue;
      }
      if (!matches) continue;
      const dedupe = `${rule.skill_id}:${rule.dedupe_fingerprint}:${context.run_id}`;
      if (seenDeviations.has(dedupe)) continue;
      seenDeviations.add(dedupe);
      await this.recordWorkGraph('task_deviation', task, context, {
        sessionHandle: sessionId,
        skill_id: rule.skill_id,
        evidence_kind: rule.evidence_kind,
        dedupe_key: dedupe,
      });
      this.assertNotCancelled(context.run_id);
      yield {
        kind: 'task.deviation',
        run_id: context.run_id,
        skill_id: rule.skill_id,
        evidence_kind: rule.evidence_kind,
        evidence_ref: evidenceRef,
        dedupe_key: dedupe,
        severity: 'warn',
      };
    }
  }

  private hydrationEnv(scope: WorkScope): Env {
    return {
      ...(this.opts.orgxEnv ?? process.env),
      ORGX_API_KEY: this.opts.orgxApiKey,
      ORGX_BASE_URL: this.opts.orgxBaseUrl,
      ORGX_WORKSPACE_ID: scope.workspaceId,
      ORGX_INITIATIVE_ID: scope.initiativeId,
      ORGX_WORKSTREAM_ID: scope.workstreamId,
      ORGX_TASK_ID: scope.taskId,
    };
  }

  private rememberCancellation(runId: string): void {
    if (!this.cancelledRuns.has(runId)) {
      while (this.cancelledRuns.size >= MAX_CANCELLED_RUN_TOMBSTONES) {
        const oldest = this.cancelledRuns.values().next().value;
        if (typeof oldest !== 'string') break;
        this.cancelledRuns.delete(oldest);
      }
    }
    this.cancelledRuns.add(runId);
  }

  private assertNotCancelled(runId: string): void {
    if (this.cancelledRuns.has(runId)) {
      throw new Error(CANCELLED_DISPATCH_REASON);
    }
  }

  private async abortNativeSession(active: ActiveRun): Promise<void> {
    await active.client.session
      .abort(
        { sessionID: active.sessionId, directory: active.directory },
        { throwOnError: true, redirect: 'error' }
      )
      .catch(() => undefined);
  }

  private async clearAuthority(active: ActiveRun): Promise<SessionContextClearance> {
    try {
      return await (
        this.opts.clearSessionWorkContext ?? clearSessionWorkContext
      )({
        env: active.env,
        projectDir: active.directory,
        sessionId: active.sessionId,
      });
    } catch {
      return { cleared: false, reason: 'wizard_unavailable' };
    }
  }

  private async client(directory?: string): Promise<OpencodeClient> {
    const baseUrl = await this.resolveBaseUrl();
    return (this.opts.createClient ?? createOpencodeClient)({
      baseUrl,
      ...(directory ? { directory } : {}),
      redirect: 'error',
    });
  }

  private async resolveBaseUrl(): Promise<string> {
    if (this.baseUrlCache) return this.baseUrlCache;
    if (this.opts.openCodeServerUrl !== undefined) {
      const explicit = resolveSafeOpenCodeServerUrl(this.opts.openCodeServerUrl);
      if (!explicit) throw new Error('Unsafe OpenCode server URL');
      this.baseUrlCache = explicit;
      return explicit;
    }
    const statePath = this.opts.statePath ?? defaultStatePath();
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
      port?: unknown;
    };
    if (
      !Number.isInteger(state.port) ||
      (state.port as number) < 1 ||
      (state.port as number) > 65_535
    ) {
      throw new Error(`OpenCode state file missing port: ${statePath}`);
    }
    this.baseUrlCache = `http://127.0.0.1:${state.port as number}`;
    return this.baseUrlCache;
  }

  private async recordWorkGraph(
    event: string,
    task: DispatchableTask,
    context: DriverContext,
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
      cwd: task.repo_path?.trim() || undefined,
      summary: { ...summary, idempotency_key: context.idempotency_key },
    });
  }

  private async replayWorkGraph(): Promise<void> {
    try {
      await this.opts.replayWorkGraph?.();
    } catch (error) {
      capturePluginException(error, { stage: 'work_graph_replay' });
    }
  }
}

async function* retryStartedUntilAccepted(
  outcome: Promise<ActivationAcceptanceOutcome>,
  startedMessage: DriverOutboundMessage,
  retryMs = DEFAULT_ACTIVATION_RETRY_MS
): AsyncGenerator<DriverOutboundMessage> {
  if (!Number.isFinite(retryMs) || retryMs < 1) {
    throw new Error('Gateway activation retry interval is invalid');
  }
  const interval = Math.min(Math.round(retryMs), MAX_ACTIVATION_RETRY_MS);
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      outcome,
      new Promise<{ kind: 'retry' }>((resolveRetry) => {
        timer = setTimeout(() => resolveRetry({ kind: 'retry' }), interval);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (result.kind === 'accepted') return;
    if (result.kind === 'rejected') throw result.error;
    yield startedMessage;
  }
}

export function resolveSafeOpenCodeServerUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(
        url.hostname.toLowerCase()
      ) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveDispatchWorkScope(
  task: ScopedTask,
  envelope: ExecutionEnvelope | undefined,
  configuredWorkspaceId?: string
): WorkScope {
  const fromTask = {
    workspaceId: declaredId(task, 'workspace_id'),
    initiativeId: declaredId(task, 'initiative_id'),
    workstreamId: declaredId(task, 'workstream_id'),
    taskId: declaredId(task, 'task_id'),
  };
  const fromEnvelope = envelope?.workRef;
  const envelopeScope = fromEnvelope
    ? {
        workspaceId: declaredId(fromEnvelope, 'workspaceId'),
        initiativeId: declaredId(fromEnvelope, 'initiativeId'),
        workstreamId: declaredId(fromEnvelope, 'workstreamId'),
        taskId: declaredId(fromEnvelope, 'taskId'),
      }
    : undefined;
  for (const key of [
    'workspaceId',
    'initiativeId',
    'workstreamId',
    'taskId',
  ] as const) {
    if (
      envelopeScope?.[key] &&
      fromTask[key] &&
      envelopeScope[key] !== fromTask[key]
    ) {
      throw new Error(`OrgX ${key} mismatch between task and execution envelope`);
    }
  }
  const workspaceId =
    envelopeScope?.workspaceId ??
    fromTask.workspaceId ??
    optionalId(configuredWorkspaceId);
  if (!workspaceId) throw new Error('OrgX dispatch is missing workspace scope');
  if (configuredWorkspaceId && workspaceId !== configuredWorkspaceId.trim()) {
    throw new Error('OrgX dispatch workspace does not match the connected peer');
  }
  const scope: WorkScope = {
    workspaceId,
    initiativeId: envelopeScope?.initiativeId ?? fromTask.initiativeId,
    workstreamId: envelopeScope?.workstreamId ?? fromTask.workstreamId,
    taskId: envelopeScope?.taskId ?? fromTask.taskId,
  };
  if (scope.workstreamId && !scope.initiativeId) {
    throw new Error('OrgX workstream scope requires an initiative');
  }
  if (scope.taskId && (!scope.initiativeId || !scope.workstreamId)) {
    throw new Error('OrgX task scope requires an initiative and workstream');
  }
  return scope;
}

function mapNativeEvent(
  event: NativeEvent,
  sessionId: string,
  seen: Set<string>
): OpenCodeEvent[] {
  if (event.type === 'session.next.text.delta') {
    if (event.properties.sessionID !== sessionId) return [];
    const key = `chat:${event.properties.assistantMessageID}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ kind: 'chat' }];
  }
  if (event.type === 'session.next.tool.called') {
    if (event.properties.sessionID !== sessionId) return [];
    const key = `tool:${event.properties.callID}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        kind: 'tool_call',
        tool: event.properties.tool,
        summary: 'started native tool call',
        ref: event.properties.callID,
      },
    ];
  }
  if (
    event.type === 'message.part.updated' &&
    event.properties.sessionID === sessionId &&
    event.properties.part.sessionID === sessionId &&
    event.properties.part.type === 'tool'
  ) {
    return mapToolPart(event.properties.part, seen);
  }
  if (
    event.type === 'session.diff' &&
    event.properties.sessionID === sessionId
  ) {
    return mapDiffs(event.properties.diff, seen);
  }
  return [];
}

function mapTerminalParts(parts: Part[], seen: Set<string>): OpenCodeEvent[] {
  const events: OpenCodeEvent[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text.trim()) {
      const key = `chat:${part.messageID}`;
      if (!seen.has(key)) {
        seen.add(key);
        events.push({ kind: 'chat' });
      }
    }
    if (part.type === 'tool') events.push(...mapToolPart(part, seen));
  }
  return events;
}

function mapToolPart(
  part: Extract<Part, { type: 'tool' }>,
  seen: Set<string>
): OpenCodeEvent[] {
  if (part.state.status !== 'completed' && part.state.status !== 'error') return [];
  const key = `tool:${part.callID}`;
  if (seen.has(key)) return [];
  seen.add(key);
  return [
    {
      kind: 'tool_call',
      tool: part.tool,
      summary:
        part.state.status === 'completed'
          ? 'completed native tool call'
          : 'native tool call failed',
      ref: part.callID,
    },
  ];
}

function mapDiffs(
  diffs: SnapshotFileDiff[],
  seen: Set<string>
): OpenCodeEvent[] {
  const events: OpenCodeEvent[] = [];
  for (const diff of diffs) {
    if (!diff.file) continue;
    const key = `diff:${diff.file}:${diff.additions}:${diff.deletions}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      kind: 'file_edit',
      path: diff.file,
      summary: `${diff.status ?? 'modified'} (+${diff.additions}/-${diff.deletions})`,
      diff_ref: diff.file,
    });
  }
  return events;
}

function verifiedAdditionalContext(result: ContextPackHydrationResult): string {
  const context = result.additionalContext;
  if (
    !result.ok ||
    result.sessionContext?.activated !== true ||
    typeof context !== 'string' ||
    !context ||
    Buffer.byteLength(context, 'utf8') > MAX_ADDITIONAL_CONTEXT_BYTES
  ) {
    throw new Error(
      `OrgX exact-session context activation failed (${result.sessionContext?.reason ?? result.skipped ?? 'unverified'})`
    );
  }
  return context;
}

function parseGatewayContextActivation(
  value: unknown
): GatewayContextActivation | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    throw new Error('OrgX dispatch context activation is invalid');
  }
  const record = value;
  const sessionActivation = record.session_activation;
  const contextSha256 = record.context_sha256;
  const activationSha256 = record.activation_sha256;
  if (
    record.schema_version !==
      'orgx-gateway-session-context-activation/v1' ||
    record.source_client !== 'opencode' ||
    !isRecord(sessionActivation) ||
    sessionActivation.schema_version !== 'orgx-session-activation/v1' ||
    typeof contextSha256 !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(contextSha256) ||
    typeof activationSha256 !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(activationSha256)
  ) {
    throw new Error('OrgX dispatch context activation is invalid');
  }
  if (
    Buffer.byteLength(JSON.stringify(sessionActivation), 'utf8') > 64 * 1024 ||
    !isValidActivationCompaction(sessionActivation.compaction)
  ) {
    throw new Error('OrgX session activation wrapper is invalid');
  }
  if (`sha256:${canonicalJsonSha256(sessionActivation)}` !== activationSha256) {
    throw new Error('OrgX dispatch session activation digest mismatch');
  }
  const activationScope = readActivationScope(sessionActivation.scope);
  const context = sessionActivation.work_context;
  if (
    !isRecord(context) ||
    context.schema_version !== 'orgx-session-work-context/v1' ||
    Buffer.byteLength(JSON.stringify(context), 'utf8') >
      MAX_SESSION_WORK_CONTEXT_BYTES ||
    `sha256:${sessionWorkContextSha256(context)}` !== contextSha256
  ) {
    throw new Error('OrgX dispatch context activation digest mismatch');
  }
  return {
    sessionActivation,
    workContext: context,
    scope: activationScope,
    contextSha256: contextSha256 as `sha256:${string}`,
    activationSha256: activationSha256 as `sha256:${string}`,
  };
}

function parseGatewayExecutionAttribution(
  value: unknown
): GatewayExecutionAttribution {
  if (!isRecord(value)) {
    throw new Error('OrgX dispatch is missing execution attribution');
  }
  const provider = value.provider;
  const parsedProviderId =
    value.provider_id === null ? null : optionalId(value.provider_id);
  const observedAt = value.observed_at;
  if (
    !['anthropic', 'openai', 'other'].includes(provider as string) ||
    (value.provider_id !== null && !parsedProviderId) ||
    value.source_sub_type !== 'user_managed' ||
    typeof observedAt !== 'string' ||
    !Number.isFinite(Date.parse(observedAt))
  ) {
    throw new Error('OrgX dispatch execution attribution is invalid');
  }
  const providerId = parsedProviderId ?? null;
  if (
    (providerId === null && provider !== 'other') ||
    (providerId !== null && providerKind(providerId) !== provider)
  ) {
    throw new Error('OrgX execution attribution provider ID is inconsistent');
  }
  return {
    provider: provider as GatewayExecutionAttribution['provider'],
    providerId,
    sourceSubType: 'user_managed',
    observedAt,
  };
}

function readActivationScope(value: unknown): WorkScope {
  if (!isRecord(value)) {
    throw new Error('OrgX session activation scope is invalid');
  }
  const workspaceId = declaredId(value, 'workspace_id');
  if (!workspaceId) {
    throw new Error('OrgX session activation scope is missing workspace');
  }
  const scope: WorkScope = {
    workspaceId,
    initiativeId: declaredId(value, 'initiative_id'),
    workstreamId: declaredId(value, 'workstream_id'),
    taskId: declaredId(value, 'task_id'),
  };
  if (scope.workstreamId && !scope.initiativeId) {
    throw new Error('OrgX session activation hierarchy is invalid');
  }
  if (scope.taskId && (!scope.initiativeId || !scope.workstreamId)) {
    throw new Error('OrgX session activation hierarchy is invalid');
  }
  return scope;
}

function reconcileActivationScope(
  dispatchScope: WorkScope,
  activationScope: WorkScope
): WorkScope {
  for (const key of [
    'workspaceId',
    'initiativeId',
    'workstreamId',
    'taskId',
  ] as const) {
    if (
      dispatchScope[key] !== undefined &&
      dispatchScope[key] !== activationScope[key]
    ) {
      throw new Error(`OrgX ${key} mismatch with session activation`);
    }
  }
  return activationScope;
}

function isValidActivationCompaction(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.compacted !== 'boolean' ||
    typeof value.summary_truncated !== 'boolean' ||
    !hasNonNegativeCounts(value.omitted_counts, [
      'authoritative_decisions',
      'open_risks',
      'acceptance_criteria',
      'artifact_refs',
      'evidence_refs',
      'active_constraints',
      'pending_expectations',
      'applied_learnings',
      'recent_receipt_refs',
    ]) ||
    !isRecord(value.source_capsule)
  ) {
    return false;
  }
  const capsule = value.source_capsule;
  return (
    optionalId(capsule.id) !== undefined &&
    typeof capsule.content_digest === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(capsule.content_digest) &&
    typeof capsule.generated_at === 'string' &&
    Number.isFinite(Date.parse(capsule.generated_at)) &&
    capsule.projection_consistency === 'best_effort_multi_read' &&
    hasNonNegativeCounts(capsule.omitted_counts, [
      'authoritative_decisions',
      'applied_learnings',
      'pending_expectations',
      'open_risks',
      'recent_receipt_refs',
    ]) &&
    isValidSourceCompleteness(capsule.source_completeness)
  );
}

function hasNonNegativeCounts(value: unknown, keys: string[]): boolean {
  if (!isRecord(value)) return false;
  return keys.every(
    (key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0
  );
}

function isValidSourceCompleteness(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    'authoritative_decisions',
    'current_intent',
    'recent_receipt_refs',
  ].every((key) => {
    const source = value[key];
    return (
      isRecord(source) &&
      ['complete', 'scan_limited', 'candidates_withheld'].includes(
        source.status as string
      ) &&
      Number.isSafeInteger(source.candidates_unvalidated) &&
      (source.candidates_unvalidated as number) >= 0 &&
      (source.candidates_withheld === undefined ||
        (Number.isSafeInteger(source.candidates_withheld) &&
          (source.candidates_withheld as number) >= 0))
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function renderPrompt(task: DispatchableTask): string {
  const parts = [task.title];
  if (task.description) parts.push('\n\n', task.description);
  if (task.skill_ids?.length) {
    parts.push('\n\nSkills to honor:\n');
    for (const id of task.skill_ids) parts.push(`  - ${id}\n`);
  }
  return parts.join('');
}

function providerKind(value: string): 'anthropic' | 'openai' | 'other' {
  const normalized = value.toLowerCase();
  if (normalized.includes('anthropic')) return 'anthropic';
  if (normalized.includes('openai')) return 'openai';
  return 'other';
}

function readProviderLease(value: unknown): ProviderLease | undefined {
  const providerId = optionalId(value);
  if (!providerId) return undefined;
  return {
    provider: providerKind(providerId),
    providerId,
    observedAt: new Date().toISOString(),
  };
}

function messageError(error: { name: string; data: unknown }): string {
  const data =
    error.data && typeof error.data === 'object'
      ? (error.data as Record<string, unknown>)
      : {};
  return safeErrorMessage(
    typeof data.message === 'string' ? data.message : error.name
  );
}

function optionalId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  if (!id) return undefined;
  if (Buffer.byteLength(id, 'utf8') > 512) {
    throw new Error('OrgX scope ID is too long');
  }
  return id;
}

function declaredId(
  record: object,
  key: string
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const id = optionalId((record as Record<string, unknown>)[key]);
  if (!id) throw new Error(`OrgX ${key} is invalid`);
  return id;
}

function normalizedId(value: unknown, label: string): string {
  const id = optionalId(value);
  if (!id) throw new Error(`OpenCode returned no ${label}`);
  return id;
}

function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .slice(0, 500)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\boxk_[A-Za-z0-9_-]+\b/g, 'oxk_[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/\b(api[_-]?key|token|secret)=([^\s&,;]+)/gi, '$1=[redacted]');
}

function defaultStatePath(): string {
  if (platform() === 'win32') {
    const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, 'opencode', 'state.json');
  }
  return join(homedir(), '.opencode', 'state.json');
}
