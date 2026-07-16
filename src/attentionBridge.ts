type QuestionOption = { label: string; description?: string };

export type OpenCodeQuestion = {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiple?: boolean;
};

export type OpenCodeQuestionRequest = {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestion[];
  tool?: { messageID?: string; callID?: string };
};

type FetchLike = typeof fetch;

type BridgeOptions = {
  request: OpenCodeQuestionRequest;
  apiKey: string;
  initiativeId: string;
  runId?: string;
  workstreamId?: string;
  baseUrl?: string;
  reply: (answers: string[][]) => Promise<unknown>;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
  onCreated?: (attentionIds: string[]) => void;
};

type CreatedAttention = {
  id: string;
  question: OpenCodeQuestion;
  optionIds: Map<string, string>;
};

export function parseQuestionRequest(event: unknown): OpenCodeQuestionRequest | null {
  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  if (record.type !== 'question.asked') return null;
  const payload = asRecord(record.properties) ?? asRecord(record.data);
  if (!payload) return null;
  const id = string(payload.id ?? payload.requestID);
  const sessionID = string(payload.sessionID);
  const questions = Array.isArray(payload.questions)
    ? payload.questions.map(normalizeQuestion).filter(Boolean)
    : [];
  if (!id || !sessionID || questions.length === 0) return null;
  const toolRecord = asRecord(payload.tool);
  return {
    id,
    sessionID,
    questions: questions as OpenCodeQuestion[],
    ...(toolRecord
      ? {
          tool: {
            messageID: string(toolRecord.messageID),
            callID: string(toolRecord.callID),
          },
        }
      : {}),
  };
}

export async function bridgeOpenCodeQuestions(options: BridgeOptions): Promise<void> {
  const request = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? 'https://useorgx.com').replace(/\/$/, '');
  const created: CreatedAttention[] = [];

  for (const [questionIndex, question] of options.request.questions.entries()) {
    throwIfAborted(options.signal);
    const optionIds = new Map<string, string>();
    const optionRecords = (question.options ?? []).map((option, optionIndex) => {
      const id = `q${questionIndex + 1}-o${optionIndex + 1}`;
      optionIds.set(id, option.label);
      return { id, label: option.label, ...(option.description ? { description: option.description } : {}) };
    });
    const payload = await requestJson(
      request,
      `${baseUrl}/api/client/live/attention`,
      options.apiKey,
      {
        initiative_id: options.initiativeId,
        ...(options.runId ? { run_id: options.runId } : {}),
        ...(!options.runId
          ? {
              correlation_id: trimTo(`opencode:${options.request.sessionID}`, 120),
              source_client: 'opencode',
            }
          : { source_client: 'opencode' }),
        ...(options.workstreamId ? { workstream_id: options.workstreamId } : {}),
        idempotency_key: trimTo(
          `opencode:${options.request.sessionID}:${options.request.id}:${questionIndex}`,
          120
        ),
        question: question.question,
        context: [
          question.header,
          options.request.questions.length > 1
            ? `Question ${questionIndex + 1} of ${options.request.questions.length}. OpenCode resumes after every answer arrives.`
            : null,
        ]
          .filter(Boolean)
          .join('\n\n'),
        ...(optionRecords.length ? { options: optionRecords } : {}),
        blocking: true,
        attention_kind: 'question',
        response_mode: question.multiple
          ? 'multi_select'
          : optionRecords.length
            ? 'single_select'
            : 'free_text',
        source_tool: 'question.asked',
        source_session_id: options.request.sessionID,
        source_event_id: trimTo(
          `${options.request.id}:${questionIndex}`,
          255
        ),
        impact_if_delayed:
          'The OpenCode session remains paused at its native question until every answer is returned.',
        recommended_action: 'Answer here to continue the same OpenCode session.',
        continuation: {
          strategy: 'reply_in_place',
          session_handle: options.request.sessionID,
          tool_call_id: options.request.tool?.callID ?? options.request.id,
          capability_version: 'opencode-question-v1',
        },
        metadata: {
          opencode: {
            request_id: options.request.id,
            message_id: options.request.tool?.messageID ?? null,
            call_id: options.request.tool?.callID ?? null,
            question_index: questionIndex,
            question_count: options.request.questions.length,
          },
        },
      },
      options.signal
    );
    const id = string(payload.decision_id);
    if (!id) throw new Error('OrgX attention response did not include a decision id');
    created.push({ id, question, optionIds });
    options.onCreated?.(created.map((item) => item.id));
  }

  const answers = await Promise.all(
    created.map(async (item) => {
      const payload = await pollAttention({
        request,
        baseUrl,
        apiKey: options.apiKey,
        attentionId: item.id,
        pollIntervalMs: options.pollIntervalMs ?? 2_000,
        maxWaitMs: options.maxWaitMs ?? 86_400_000,
        signal: options.signal,
      });
      return normalizeAnswer(payload.question, item.optionIds);
    })
  );

  await acknowledgeAll(request, baseUrl, options.apiKey, created, 'resuming', {
    session_handle: options.request.sessionID,
    detail: 'Returning every owner answer to the native OpenCode question.',
  });
  try {
    await options.reply(answers);
  } catch (error) {
    await acknowledgeAll(request, baseUrl, options.apiKey, created, 'resume_failed', {
      session_handle: options.request.sessionID,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await acknowledgeAll(request, baseUrl, options.apiKey, created, 'resumed', {
    session_handle: options.request.sessionID,
    detail: 'OpenCode accepted the answers in the same session.',
  });
}

async function pollAttention(input: {
  request: FetchLike;
  baseUrl: string;
  apiKey: string;
  attentionId: string;
  pollIntervalMs: number;
  maxWaitMs: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const deadline = Date.now() + input.maxWaitMs;
  while (Date.now() < deadline) {
    throwIfAborted(input.signal);
    const payload = await requestJson(
      input.request,
      `${input.baseUrl}/api/client/live/attention/${encodeURIComponent(input.attentionId)}`,
      input.apiKey,
      undefined,
      input.signal,
      'GET'
    );
    const question = asRecord(payload.question);
    if (question?.resolved === true) return payload;
    await wait(input.pollIntervalMs, input.signal);
  }
  throw new Error(`OpenCode attention timed out after ${input.maxWaitMs}ms`);
}

async function acknowledgeAll(
  request: FetchLike,
  baseUrl: string,
  apiKey: string,
  items: CreatedAttention[],
  state: 'resuming' | 'resumed' | 'resume_failed',
  detail: Record<string, unknown>
): Promise<void> {
  await Promise.all(
    items.map((item) =>
      requestJson(
        request,
        `${baseUrl}/api/client/live/attention/${encodeURIComponent(item.id)}`,
        apiKey,
        {
          state,
          idempotency_key: `opencode:${item.id}:${state}`,
          ...detail,
        }
      )
    )
  );
}

async function requestJson(
  request: FetchLike,
  url: string,
  apiKey: string,
  body?: unknown,
  signal?: AbortSignal,
  method = 'POST'
): Promise<Record<string, unknown>> {
  const response = await request(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `OrgX attention request failed (${response.status}): ${string(payload.error) ?? 'unknown error'}`
    );
  }
  return payload;
}

function normalizeQuestion(value: unknown): OpenCodeQuestion | null {
  const record = asRecord(value);
  const question = string(record?.question);
  if (!record || !question) return null;
  const options = Array.isArray(record.options)
    ? record.options
        .map((option) => {
          const item = asRecord(option);
          const label = string(item?.label);
          return label
            ? { label, ...(string(item?.description) ? { description: string(item?.description) } : {}) }
            : null;
        })
        .filter(Boolean)
    : [];
  return {
    question,
    ...(string(record.header) ? { header: string(record.header) } : {}),
    ...(options.length ? { options: options as QuestionOption[] } : {}),
    ...(record.multiple === true ? { multiple: true } : {}),
  };
}

function normalizeAnswer(
  value: unknown,
  optionIds: Map<string, string>
): string[] {
  const question = asRecord(value);
  const resolution = asRecord(question?.resolution_context);
  const raw =
    question?.answer ??
    resolution?.selected_option_ids ??
    resolution?.option_ids ??
    resolution?.answer ??
    resolution?.note ??
    '';
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .filter((item) => item != null && String(item).trim())
    .map((item) => optionIds.get(String(item)) ?? String(item));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function trimTo(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('OpenCode attention was cancelled');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('OpenCode attention was cancelled'));
      },
      { once: true }
    );
  });
}
