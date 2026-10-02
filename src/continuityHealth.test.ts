import { describe, expect, it } from 'vitest';

import { buildPluginContinuityHealth } from './continuityHealth.js';

describe('buildPluginContinuityHealth', () => {
  it('publishes the cross-plugin health contract without conflating IDs', async () => {
    const health = await buildPluginContinuityHealth({
      version: '0.1.0-alpha.7',
      authState: 'authenticated',
      endpoint: 'https://mcp.useorgx.com/mcp',
      outbox: {
        state: 'ready',
        pending: 0,
        dead_letters: 0,
        last_replay_at: '2026-07-15T12:00:00.000Z',
      },
    });

    expect(health).toEqual({
      schema_version: 'plugin-health.v1',
      endpoint: 'https://mcp.useorgx.com/mcp',
      source_client: 'opencode',
      auth_state: 'authenticated',
      release: {
        installed: '0.1.0-alpha.7',
        source: '0.1.0-alpha.7',
        deployed: '0.1.0-alpha.7',
      },
      hooks: {
        reported: 8,
        expected: 8,
        terminal_passive: true,
        events: [
          'session.created',
          'chat.message',
          'tool.execute.before',
          'tool.execute.after',
          'permission.asked',
          'session.idle',
          'session.error',
          'session.deleted',
        ],
      },
      outbox: {
        state: 'ready',
        pending: 0,
        dead_letters: 0,
        last_replay_at: '2026-07-15T12:00:00.000Z',
      },
      capture: {
        adapter: 'wizard_session_summary',
        terminal_run_event: 'session.idle',
        terminal_session_event: 'session.deleted',
        raw_content_included: false,
      },
      capabilities: {
        profile: null,
        profile_tools: null,
        manifest_tools: null,
        inspectable_entities: null,
        visible_entities: null,
        measurement: 'not_probed',
      },
      last_receipt_at: '2026-07-15T12:00:00.000Z',
    });
  });

  it('reports the profile the MCP endpoint requests, never a made-up opencode profile', async () => {
    const outbox = {
      state: 'ready' as const,
      pending: 0,
      dead_letters: 0,
      last_replay_at: null,
    };
    const scoped = await buildPluginContinuityHealth({
      version: '0.1.0-alpha.7',
      authState: 'authenticated',
      endpoint: 'https://mcp.useorgx.com/mcp?profile=commander',
      outbox,
    });
    const malformed = await buildPluginContinuityHealth({
      version: '0.1.0-alpha.7',
      authState: 'authenticated',
      endpoint: 'not a url',
      outbox,
    });

    expect(scoped.capabilities.profile).toBe('commander');
    expect(scoped.capabilities.profile_tools).toBeNull();
    expect(malformed.capabilities.profile).toBeNull();
  });
});
