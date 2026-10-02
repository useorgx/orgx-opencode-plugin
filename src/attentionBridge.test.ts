import { describe, expect, it, vi } from 'vitest';

import {
  bridgeOpenCodeQuestions,
  parseQuestionRequest,
} from './attentionBridge.js';

describe('OpenCode attention bridge', () => {
  it('parses native question events in the plugin event shape', () => {
    expect(
      parseQuestionRequest({
        type: 'question.asked',
        properties: {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [
            {
              header: 'Direction',
              question: 'Which direction?',
              options: [{ label: 'Quiet', description: 'Restrained' }],
            },
          ],
          tool: { messageID: 'message-1', callID: 'call-1' },
        },
      })
    ).toEqual({
      id: 'request-1',
      sessionID: 'session-1',
      questions: [
        {
          header: 'Direction',
          question: 'Which direction?',
          options: [{ label: 'Quiet', description: 'Restrained' }],
        },
      ],
      tool: { messageID: 'message-1', callID: 'call-1' },
    });
  });

  it('returns all owner answers to the same native request and records continuation', async () => {
    const posts: Array<Record<string, unknown>> = [];
    let created = 0;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/api/client/live/attention')) {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        created += 1;
        return Response.json({ decision_id: `decision-${created}` });
      }
      if (init?.method === 'GET') {
        const decisionId = href.split('/').at(-1);
        return Response.json({
          question: {
            resolved: true,
            answer: decisionId === 'decision-1' ? 'q1-o1' : 'Keep the wordmark',
          },
        });
      }
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    });
    const reply = vi.fn(async () => true);

    await bridgeOpenCodeQuestions({
      request: {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [
          {
            header: 'Direction',
            question: 'Which direction?',
            options: [{ label: 'Quiet signal' }, { label: 'Loud signal' }],
          },
          { header: 'Constraint', question: 'What stays unchanged?' },
        ],
      },
      apiKey: 'oxk_test',
      initiativeId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      baseUrl: 'https://useorgx.test',
      reply,
      fetchImpl: request as typeof fetch,
      pollIntervalMs: 0,
    });

    expect(reply).toHaveBeenCalledWith([
      ['Quiet signal'],
      ['Keep the wordmark'],
    ]);
    expect(posts.slice(0, 2).map((body) => body.source_tool)).toEqual([
      'question.asked',
      'question.asked',
    ]);
    expect(
      posts.filter((body) => body.state === 'resuming')
    ).toHaveLength(2);
    expect(posts.filter((body) => body.state === 'resumed')).toHaveLength(2);
  });

  it('reports a failed native reply instead of claiming the session resumed', async () => {
    const receipts: string[] = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/api/client/live/attention')) {
        return Response.json({ decision_id: 'decision-1' });
      }
      if (init?.method === 'GET') {
        return Response.json({ question: { resolved: true, answer: 'Continue' } });
      }
      const body = JSON.parse(String(init?.body)) as { state?: string };
      if (body.state) receipts.push(body.state);
      return Response.json({ ok: true });
    });

    await expect(
      bridgeOpenCodeQuestions({
        request: {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [{ question: 'Continue?' }],
        },
        apiKey: 'oxk_test',
        initiativeId: '11111111-1111-4111-8111-111111111111',
        baseUrl: 'https://useorgx.test',
        reply: async () => {
          throw new Error('native request disappeared');
        },
        fetchImpl: request as typeof fetch,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow('native request disappeared');
    expect(receipts).toEqual(['resuming', 'resume_failed']);
  });

  it('sends each write idempotency_key as a stable Idempotency-Key header', async () => {
    const writes: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = [];
    const gets: Array<string | null> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const key = new Headers(init?.headers).get('idempotency-key');
      if (init?.method === 'GET') {
        gets.push(key);
        return Response.json({ question: { resolved: true, answer: 'Continue' } });
      }
      writes.push({ url: href, key, body: JSON.parse(String(init?.body)) });
      return href.endsWith('/api/client/live/attention')
        ? Response.json({ decision_id: 'decision-1' })
        : Response.json({ ok: true });
    });
    const run = () =>
      bridgeOpenCodeQuestions({
        request: {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [{ question: 'Continue?' }],
        },
        apiKey: 'oxk_test',
        initiativeId: '11111111-1111-4111-8111-111111111111',
        baseUrl: 'https://useorgx.test',
        reply: async () => true,
        fetchImpl: request as typeof fetch,
        pollIntervalMs: 0,
      });

    await run();
    const firstAttempt = writes.splice(0);
    await run();

    expect(firstAttempt.map((write) => write.key)).toEqual([
      'opencode:session-1:request-1:0',
      'opencode:decision-1:resuming',
      'opencode:decision-1:resumed',
    ]);
    for (const write of firstAttempt) expect(write.key).toBe(write.body.idempotency_key);
    expect(writes).toEqual(firstAttempt);
    expect(gets.every((key) => key === null)).toBe(true);
  });
});
