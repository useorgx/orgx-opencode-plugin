# orgx-opencode-plugin

OrgX plugin peer for **OpenCode**. One of three reference peers (alongside `orgx-claude-code-plugin` and `orgx-codex-plugin`) that uses [`@useorgx/orgx-gateway-sdk`](https://github.com/useorgx/orgx-gateway-sdk), pinned to a release that supports Gateway protocols v1 and v2.

The production peer deliberately negotiates v1 today: a successful OpenCode
session is not, by itself, a canonical `ProofPacket`. The protocol will move to
v2 only when the driver can return the envelope-bound proof, receipt, artifact,
cost, and outcome references required by `ExecutionResult`.
An unexpected protocol-v2 task dispatch therefore fails before OpenCode creates
a native session; the plugin never substitutes a v1 completion for v2 proof.

**The peer model:** this plugin opens its own authenticated WebSocket to OrgX server, receives `task.dispatch` messages, runs them in your local OpenCode session (your user-managed provider account pays the tokens), and posts receipts + deviations back. It also writes compact, redacted Work Graph events locally so audit-first reconciliation can preserve progress and fingerprints across signup. No central broker. If another peer goes down, this one keeps running.

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
events. Capture is metadata-only by default. Set
`ORGX_SESSION_WORK_EPISODE_CAPTURE=bounded` to let the Wizard retain bounded,
redacted user-intent excerpts. The adapter does not send tool arguments, tool
results, error text, transcripts, credentials, or model output. The Wizard owns
queue durability, acknowledgement, retry, privacy normalization, and AWR
delivery.
If the Wizard hook is absent or incompatible, the plugin records that capture
is unavailable and continues without inventing a receipt.

Set `ORGX_SESSION_SUMMARY_AUTO_FLUSH=off` for a deliberately offline run. The
adapter and Wizard retain the capture without starting a delivery worker;
`orgx-wizard hooks flush` can replay it later with server acknowledgement.

### Session context continuity

For a Gateway-dispatched task, OrgX sends a dual-digest-bound
`context_activation` and a `user_managed` execution-attribution lease. One
digest covers the exact work context; the second covers the full session
activation wrapper, including scope, compaction, source-capsule completeness,
and omitted counts. The
lease is required before native session creation. A first-run lease may be
explicitly unknown (`provider: "other"`, `provider_id: null`); otherwise its
provider ID must exactly match the provider returned by OpenCode. The driver
creates the native OpenCode session first,
validates that activation and its canonical digest, activates the exact native
session through the Wizard, then acknowledges it in `task.started`. The first
prompt remains blocked until the Gateway returns an exact
`task.activation.accepted` tuple for the same run, both digests, and native
session.
The identical acknowledgement is retried on a bounded interval, including
across reconnectable socket closes, so a lost first acceptance frame does not
create a second native session or prompt. Rejection, mismatch, terminal close,
or the overall timeout clears that session's lease without prompting. A
missing, mismatched, or unverified v2 activation fails closed; the task is not
prompted with ambient organizational authority.

For an interactive session without a Gateway activation, `session.created`
(or the first session-bound message/model request if that event was missed)
requests one context pack for the most specific configured anchor: task,
workstream, initiative, then workspace. Hydration is exactly once per native
OpenCode session. Internal model requests without a native session ID receive
no OrgX context or authority.

The full pack and any pending activation are stored outside the repository in
owner-only Wizard state. Each directory is keyed by the SHA-256 of the resolved
project cwd plus native session ID, so two sessions in one checkout cannot
overwrite each other's files. By default the state is under
`$ORGX_WIZARD_CONFIG_HOME/opencode-contexts/` or
`$XDG_CONFIG_HOME/useorgx/wizard/opencode-contexts/` (falling back to
`~/.config/useorgx/wizard/opencode-contexts/`). No runtime context file is
written into `.opencode/` or made visible to Git.

Whether the context came from a Gateway dispatch or the interactive fetch, the
plugin passes that exact object to:

```bash
orgx-wizard sessions context set --file - --cwd <active-project> \
  --source-client opencode --session-id <native-session-id> \
  --context-sha256 <canonical-context-sha256> --json
```

The digest is calculated from recursively key-sorted JSON (array order is
preserved and undefined values are omitted). The plugin accepts activation only
when the Wizard returns the v1 acknowledgement and v2 activation versions plus
the exact resolved cwd, source client, native session ID, and digest. It clears
that exact lease on `session.deleted`, and it clears stale authority when a
refresh fails or returns an invalid API envelope. If the Wizard is offline, the
plugin keeps the exact context in that session's private pending file.
Interactive sessions may continue with briefing explicitly marked
non-authoritative; Gateway dispatches fail before prompting. Context fetch and
activation each time out after 3 seconds by default.
`ORGX_CONTEXT_PACK_TIMEOUT_MS` and
`ORGX_SESSION_CONTEXT_ACTIVATION_TIMEOUT_MS` accept values from 250 to 10,000
milliseconds.

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
export OPENCODE_SERVER_URL=http://127.0.0.1:4096
orgx-opencode-plugin
```

Or programmatic:

```ts
import { startPeer } from '@useorgx/orgx-opencode-plugin/sdk';

const peer = await startPeer({
  apiKey: process.env.ORGX_API_KEY!,
  workspaceId: process.env.ORGX_WORKSPACE_ID!,
  openCodeServerUrl: 'http://127.0.0.1:4096',
  openCodeDirectory: process.cwd(),
});
// later:
await peer.stop();
```

## How it talks to OpenCode

The native plugin passes OpenCode's authoritative `serverUrl` and project
directory directly to the peer. The standalone CLI accepts the credential-free
loopback origin through `OPENCODE_SERVER_URL`; its local state-file lookup is a
compatibility fallback only. Userinfo, remote hosts, paths, query strings, and
redirects are rejected.

The driver uses the installed `@opencode-ai/sdk/v2` client rather than private
HTTP routes:

1. `global.health`, `provider.list`, and `session.status` report health.
2. `session.create` returns the native session ID and authoritative
   `Session.model.providerID` dispatch lease.
3. OrgX context is activated for that exact ID and acknowledged.
4. The Gateway durably accepts that exact activation acknowledgement.
5. `event.subscribe` provides an abortable, exact-session progress stream.
6. `session.prompt` sends the first turn with the verified bounded context.
7. `session.diff` reads files attributable to the returned user message;
   `session.abort` cancels only the session mapped to that OrgX run.

The terminal `AssistantMessage.providerID` must exactly match the session's
native provider lease. The terminal receipt then echoes the immutable Gateway
route attribution—including `provider_id: null` when the route deliberately
left the user-managed provider unknown—rather than silently replacing it with
a later observation. A non-null route provider ID must match the native lease
before the session can run, and the terminal source subtype remains
`user_managed`. The separate `observed_provider_id` terminal field records the
provider learned from that exact native session, so a first-run unknown route
can become an attributed observation without rewriting its routing history.
Presence separately reports the latest observed provider in
`execution_provider`, `execution_provider_id`, and
`execution_provider_observed_at`. `execution_auth_method` remains `null`
because the official SDK does not distinguish an opaque stored OAuth
credential from a stored API key; the plugin does not guess.

Each attributed file diff or tool event becomes a `task.step` wire message.
Every skill rule fetched from `/api/v1/plan-skills` runs against that stream;
matches become `task.deviation` events, deduped per run, skill, and fingerprint.
A completed model turn is reported as `awaiting_review`, not `shipped`, until a
separate acceptance or delivery receipt proves the stronger lifecycle state.

## Work Graph reconciliation

The driver writes passive event summaries to
`~/.config/useorgx/wizard/hooks/events.jsonl` by default. Set
`ORGX_WIZARD_HOOK_OUTBOX` to override the path, or pass
`workGraphOutboxPath: false` when starting the peer programmatically to disable
the local trail.

These JSONL records are intentionally compact. They include source client,
event kind, run/session handles, repo path, evidence refs, and counts; they do
not include raw prompts, raw transcripts, API keys, tokens, or storage state.
For a Gateway activation, `task_started` is written only after the exact
activation acceptance arrives; a proposed, rejected, or timed-out activation
never enters the local organizational-truth trail as started work.
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
