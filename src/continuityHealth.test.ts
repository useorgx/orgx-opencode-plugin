import { describe, expect, it } from 'vitest';

import { buildPluginContinuityHealth } from './continuityHealth.js';

describe('buildPluginContinuityHealth', () => {
  it('publishes the cross-plugin health contract without conflating IDs', async () => {
    const health = await buildPluginContinuityHealth({
      version: '0.1.0-alpha.6',
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
      auth_state: 'authenticated',
      release: {
        installed: '0.1.0-alpha.6',
        source: '0.1.0-alpha.6',
        deployed: '0.1.0-alpha.6',
      },
      hooks: {
        reported: 4,
        expected: 4,
        terminal_passive: true,
        events: [
          'task_started',
          'task_step',
          'task_completed',
          'task_failed',
        ],
      },
      outbox: {
        state: 'ready',
        pending: 0,
        dead_letters: 0,
        last_replay_at: '2026-07-15T12:00:00.000Z',
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
