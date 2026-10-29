import { describe, expect, it } from 'vitest';

import { buildPluginContinuityHealth } from './continuityHealth.js';

describe('buildPluginContinuityHealth', () => {
  it('reports the endpoint profile without fabricating capability counts', async () => {
    const health = await buildPluginContinuityHealth({
      version: '0.1.0-alpha.7',
      authState: 'authenticated',
      endpoint: 'https://mcp.useorgx.com/mcp?profile=executor',
      outbox: {
        state: 'ready',
        pending: 0,
        dead_letters: 0,
        last_replay_at: '2026-07-15T12:00:00.000Z',
      },
    });

    expect(health).toEqual({
      schema_version: 'plugin-health.v1',
      endpoint: 'https://mcp.useorgx.com/mcp?profile=executor',
      source_client: 'opencode',
      auth_state: 'authenticated',
      release: {
        installed: '0.1.0-alpha.7',
        source: '0.1.0-alpha.7',
        deployed: '0.1.0-alpha.7',
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
        profile: 'executor',
        profile_tools: null,
        manifest_tools: null,
        inspectable_entities: null,
        visible_entities: null,
        measurement: 'not_probed',
      },
      last_receipt_at: '2026-07-15T12:00:00.000Z',
    });
  });

  it('publishes counts only from an explicit capability snapshot', async () => {
    const health = await buildPluginContinuityHealth({
      version: '0.1.0-alpha.7',
      authState: 'authenticated',
      endpoint: 'https://mcp.useorgx.com/mcp?profile=executor',
      capabilitySnapshot: {
        profile_tools: 9,
        manifest_tools: 37,
        inspectable_entities: 6,
        visible_entities: 5,
      },
      outbox: {
        state: 'ready',
        pending: 0,
        dead_letters: 0,
        last_replay_at: null,
      },
    });

    expect(health.capabilities).toEqual({
      profile: 'executor',
      profile_tools: 9,
      manifest_tools: 37,
      inspectable_entities: 6,
      visible_entities: 5,
      measurement: 'measured',
    });
  });
});
