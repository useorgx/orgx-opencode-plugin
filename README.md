# orgx-opencode-plugin

OrgX plugin peer for **OpenCode**. One of three reference peers (alongside `orgx-claude-code-plugin` and `orgx-codex-plugin`) that implements [`@useorgx/orgx-gateway-sdk`](https://github.com/useorgx/orgx-gateway-sdk) Protocol v1.

**The peer model:** this plugin opens its own authenticated WebSocket to OrgX server, receives `task.dispatch` messages, runs them in your local OpenCode session (your subscription pays the tokens), and posts receipts + deviations back. It also writes compact, redacted Work Graph events locally so audit-first reconciliation can preserve progress and fingerprints across signup. No central broker. If another peer goes down, this one keeps running.

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

## Work Graph reconciliation

The driver writes passive event summaries to
`~/.config/useorgx/wizard/hooks/events.jsonl` by default. Set
`ORGX_WIZARD_HOOK_OUTBOX` to override the path, or pass
`workGraphOutboxPath: false` when starting the peer programmatically to disable
the local trail.

These JSONL records are intentionally compact. They include source client,
event kind, run/session handles, repo path, evidence refs, and counts; they do
not include raw prompts, raw transcripts, API keys, tokens, or storage state.
The OrgX wizard can later use them to detect missed OrgX writeback, generate a
shareable public Work Graph readout, and hydrate the fingerprint into a signed-up
workspace.

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

## Release

Publishing is handled by `.github/workflows/publish.yml` when a GitHub release
is published. The workflow uses npm trusted publishing/OIDC and automatically
uses the `alpha` dist-tag for prerelease versions such as `0.1.0-alpha.1`.

Configure the package trusted publisher on npmjs.com with:

- Publisher: GitHub Actions
- Organization or user: `useorgx`
- Repository: `orgx-opencode-plugin`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`
- Environment name: leave empty unless this workflow is later moved behind a GitHub environment

The package `repository.url` must keep matching this GitHub repository exactly,
otherwise npm trusted publishing can fail authentication.

If the release workflow builds successfully but fails at `npm publish` with
`E404` / "not found or you do not have permission", re-check the npm package's
trusted publisher settings above. The workflow uses OIDC, so a local npm login
is not used by GitHub Actions.

## Status

Alpha. Part of the Sovereign Execution initiative (`993cabeb`).
