type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

export type OpenCodeV2Canary = {
  schema_version: 'orgx.opencode-v2-canary/v1';
  enabled: boolean;
  state: 'disabled' | 'unsupported' | 'ready';
  capabilities: {
    session_hooks: boolean;
    tool_hooks: boolean;
    event_stream: boolean;
  };
  gaps: string[];
};

export function inspectOpenCodeV2Canary(
  context: unknown,
  enabled = process.env.ORGX_OPENCODE_V2_CANARY === '1'
): OpenCodeV2Canary {
  const value = record(context);
  const session = record(value.session);
  const tool = record(value.tool);
  const event = record(value.event);
  const capabilities = {
    session_hooks: typeof session.hook === 'function',
    tool_hooks: typeof tool.hook === 'function',
    event_stream: typeof event.subscribe === 'function',
  };
  const gaps = Object.entries(capabilities)
    .filter(([, supported]) => !supported)
    .map(([name]) => `${name}_unavailable`);
  return {
    schema_version: 'orgx.opencode-v2-canary/v1',
    enabled,
    state: !enabled ? 'disabled' : gaps.length > 0 ? 'unsupported' : 'ready',
    capabilities,
    gaps,
  };
}
