# orgx-opencode-plugin

OrgX plugin peer for **OpenCode**. One of three reference peers (alongside `orgx-claude-code-plugin` and `orgx-codex-plugin`) that uses [`@useorgx/orgx-gateway-sdk`](https://github.com/useorgx/orgx-gateway-sdk), pinned to a release that supports Gateway protocols v1 and v2.

The production peer deliberately negotiates v1 today: a successful OpenCode
session is not, by itself, a canonical `ProofPacket`. The protocol will move to
v2 only when the driver can return the envelope-bound proof, receipt, artifact,
cost, and outcome references required by `ExecutionResult`.

**The peer model:** this plugin opens its own authenticated WebSocket to OrgX server, receives `task.dispatch` messages, runs them in your local OpenCode session (your subscription pays the tokens), and posts receipts + deviations back. It also writes compact, redacted Work Graph events locally so audit-first reconciliation can preserve progress and fingerprints across signup. No central broker. If another peer goes down, this one keeps running.

## Install

OpenCode can load the current prerelease peer as a native plugin from
`opencode.json`. Select the `alpha` distribution tag explicitly so a fresh
install resolves the newest tested prerelease instead of npm's default tag:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@useorgx/orgx-opencode-plugin@alpha"]
}
```

Then start OpenCode with the OrgX credentials available in the environment:

```bash
export ORGX_API_KEY=oxk_...
export ORGX_WORKSPACE_ID=<uuid>
opencode
```

The native plugin starts the OrgX peer when the local OpenCode server connects.
Set `ORGX_BASE_URL` only when testing against a non-production OrgX API. Until
the npm package is updated, use the direct peer command below from a checked-out
copy of this repository.

### Automatic run receipts

When the OrgX Wizard capture hook is installed, the native plugin forwards an
allowlisted lifecycle shape into the shared durable session-summary queue.
`session.idle` becomes `RunEnd`, so one completed agent response can issue one
run receipt without pretending the multi-turn OpenCode conversation ended.
`session.deleted` remains the whole-session terminal boundary.

The adapter observes session, user-message, permission, and tool lifecycle
events. It sends each non-synthetic user message to the local Wizard hook for
bounded Work Episode capture: at most 12 redacted excerpts, 600 characters
each. It does not send tool arguments, tool results, error text, transcripts,
credentials, or model output. The Wizard owns queue durability,
acknowledgement, retry, privacy normalization, and AWR delivery.
If the Wizard hook is absent or incompatible, the plugin records that capture
is unavailable and continues without inventing a receipt.

Set `ORGX_SESSION_SUMMARY_AUTO_FLUSH=off` for a deliberately offline run. The
adapter and Wizard retain the capture without starting a delivery worker;
`orgx-wizard hooks flush` can replay it later with server acknowledgement.

### V2 beta canary

The production plugin stays on OpenCode's stable plugin contract. Set
`ORGX_OPENCODE_V2_CANARY=1` only in a canary process and call
`inspectOpenCodeV2Canary(context)` to inspect the beta context. The canary is
`ready` only when session hooks, tool hooks, and the public event stream are all
present; otherwise it returns an explicit `unsupported` state. Package-export
availability alone is not treated as runtime parity.

### Resumable questions

OpenCode's native `question.asked` event can be routed to the same OrgX
Attention queue used by Codex and Claude. This is opt-in because a visible
OpenCode client can still answer its local prompt first:

```bash
export ORGX_REMOTE_ATTENTION=1
export ORGX_INITIATIVE_ID=<uuid>
export ORGX_API_KEY=oxk_...
opencode
```

The plugin creates one durable attention record per native question, waits for
all related answers, replies to the original OpenCode request through the v2
local SDK, and records `resuming`, `resumed`, or `resume_failed` receipts. If
the OpenCode process exits, the durable answer remains in OrgX but cannot be
claimed as resumed until a client applies it again.

You can also run the peer directly:

```bash
npm install -g @useorgx/orgx-opencode-plugin@alpha
# or pnpm: pnpm add -g @useorgx/orgx-opencode-plugin@alpha

export ORGX_API_KEY=oxk_...
export ORGX_WORKSPACE_ID=<uuid>
orgx-opencode-plugin
```

Or programmatic:

```ts
import { startPeer } from '@useorgx/orgx-opencode-plugin/sdk';

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

Generate a local summary-only Work Graph report without credentials:

```bash
node scripts/orgx-work-graph-reconcile.mjs --output /tmp/orgx-work-graph-report.json
```

Manually post the report to OrgX when you want an immediate replay:

```bash
ORGX_API_KEY=... node scripts/orgx-work-graph-reconcile.mjs --post
```

The runtime also replays summary-only Work Graph reports privately after
terminal task events. The report fingerprint is the server idempotency key, so
retries are safe and do not create duplicate work. No raw transcript is sent.

## License heartbeat

`startPeer()` posts runtime presence every 20 seconds and a license heartbeat on
boot and every 7 days. Presence includes the shared `plugin-health.v1` contract:
endpoint/auth state, release identity, hook coverage, replay/dead-letter state,
tool-profile parity, and entity inspection coverage. The manifest is read from
`plugin.manifest.json`; when the fingerprint + signature are missing (dev
builds), the server marks the license `degraded` in permissive mode — read-only
features keep working, but deviation ingestion 402s until a signed manifest
ships.

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
