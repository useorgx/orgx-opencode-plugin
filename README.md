# orgx-opencode-plugin

OrgX plugin peer for **OpenCode**. One of three reference peers (alongside `orgx-claude-code-plugin` and `orgx-codex-plugin`) that implements [`@useorgx/orgx-gateway-sdk`](https://github.com/useorgx/orgx-gateway-sdk) Protocol v1.

**The peer model:** this plugin opens its own authenticated WebSocket to OrgX server, receives `task.dispatch` messages, runs them in your local OpenCode session (your subscription pays the tokens), and posts receipts + deviations back. No central broker. If another peer goes down, this one keeps running.

## Install + run

```bash
npm install -g @useorgx/orgx-opencode-plugin
# or pnpm: pnpm add -g @useorgx/orgx-opencode-plugin

export ORGX_API_KEY=oxk_...
export ORGX_WORKSPACE_ID=<uuid>
orgx-opencode-plugin
```

Or programmatic:

```ts
import { startPeer } from '@useorgx/orgx-opencode-plugin';

const peer = await startPeer({
  apiKey: process.env.ORGX_API_KEY!,
  workspaceId: process.env.ORGX_WORKSPACE_ID!,
});
// later:
await peer.stop();
```

## How it talks to OpenCode

The peer discovers the local OpenCode daemon via its state file:

| OS | Path |
|---|---|
| macOS / Linux | `~/.opencode/state.json` |
| Windows | `%APPDATA%/opencode/state.json` |

The state file tells us which local port the daemon listens on. The driver then:

1. `GET /status` — verifies auth + reports subscription health
2. `POST /sessions` — creates a fresh session bound to the dispatched task
3. `GET /sessions/:id/events` (NDJSON stream) — drives progress

Each `file_edit` / `tool_call` event becomes a `task.step` wire message. Every skill rule fetched from `/api/v1/plan-skills` runs against the event stream; matches become `task.deviation` events (deduped per (run_id, skill_id, fingerprint)).

## License heartbeat

`startPeer()` posts `POST /api/v1/licenses/heartbeat` on boot and then every 7 days. The manifest is read from `plugin.manifest.json`; when the fingerprint + signature are missing (dev builds), the server marks the license `degraded` in permissive mode — read-only features keep working, but deviation ingestion 402s until a signed manifest ships.

## Skills

Rules are fetched once per peer boot from `GET /api/v1/plan-skills?workspace_id=…`. The shape is:

```ts
{
  skills: [
    {
      id: 'parametrize-tests',
      rules: [
        { pattern: 'parametrize', on: 'file_edit',
          dedupe_fingerprint: '...', evidence_kind: 'test_style_shift' }
      ]
    }
  ]
}
```

Additions / demotions take effect on peer restart (or via an in-band "rules reload" message in a follow-up).

## Development

```bash
npm install
npm run type-check
npm test
npm run build
```

## Status

Alpha. Part of the Sovereign Execution initiative (`993cabeb`).
