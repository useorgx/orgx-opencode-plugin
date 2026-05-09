# AGENTS.md

Guidelines for Codex and other agents working in `useorgx/orgx-opencode-plugin`.

## Project

This repo is the OpenCode peer plugin for OrgX Gateway Protocol v1 and passive Work Graph reconciliation.

## Setup

For Codex cloud, use:

```bash
bash .codex/setup-cloud.sh
```

Maintenance script for cached environments:

```bash
bash .codex/maintenance-cloud.sh
```

## Verification

```bash
npm run type-check
npm test
npm run build
```

Do not treat local OpenCode daemon availability as a cloud setup requirement. Mock or isolate daemon-dependent behavior unless the task specifically asks for local integration testing.
