import { describe, expect, it } from 'vitest';

import { inspectOpenCodeV2Canary } from './v2Canary';

describe('OpenCode V2 canary', () => {
  it('stays disabled unless explicitly selected', () => {
    expect(inspectOpenCodeV2Canary({}, false)).toEqual({
      schema_version: 'orgx.opencode-v2-canary/v1',
      enabled: false,
      state: 'disabled',
      capabilities: {
        session_hooks: false,
        tool_hooks: false,
        event_stream: false,
      },
      gaps: [
        'session_hooks_unavailable',
        'tool_hooks_unavailable',
        'event_stream_unavailable',
      ],
    });
  });

  it('fails closed when the beta context lacks the required hook surfaces', () => {
    expect(inspectOpenCodeV2Canary({ agent: {} }, true).state).toBe(
      'unsupported'
    );
  });

  it('reports ready only when all three beta capabilities are present', () => {
    expect(
      inspectOpenCodeV2Canary(
        {
          session: { hook() {} },
          tool: { hook() {} },
          event: { subscribe() {} },
        },
        true
      )
    ).toMatchObject({ state: 'ready', gaps: [] });
  });
});
