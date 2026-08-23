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
          'message.updated:user',
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
        profile: 'opencode',
        profile_tools: 33,
        manifest_tools: 33,
        inspectable_entities: 20,
        visible_entities: 20,
      },
      last_receipt_at: '2026-07-15T12:00:00.000Z',
    });
  });
});
