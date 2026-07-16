/**
 * Peer runtime — wires OpenCodeDriver into PeerClient and ships the
 * license heartbeat on boot + every 24h.
 *
 * Usage (CLI or programmatic):
 *
 *   import { startPeer } from '@useorgx/orgx-opencode-plugin';
 *   await startPeer({
 *     apiKey: process.env.ORGX_API_KEY,
 *     workspaceId: process.env.ORGX_WORKSPACE_ID,
 *     baseUrl: 'wss://useorgx.com',
 *   });
 */

import { PeerClient, type Driver } from '@useorgx/orgx-gateway-sdk';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { OpenCodeDriver } from './OpenCodeDriver.js';
import {
  buildPluginContinuityHealth,
  type ContinuityOutboxHealth,
} from './continuityHealth.js';
import {
  capturePluginException,
  initializePluginSentry,
} from './sentry.js';
import { createWorkGraphReplay } from './workGraphReplay.js';

const PRESENCE_HEARTBEAT_MS = 20_000;
const LICENSE_HEARTBEAT_MS = 7 * 24 * 60 * 60 * 1000;
const PLUGIN_ID = 'orgx-opencode-plugin';
// Protocol v2 requires a canonical proof-bearing ExecutionResult. Keep the
// production peer on v1 until the driver can obtain that proof from OrgX.
const GATEWAY_PROTOCOL_VERSION = 1;

export type StartPeerOptions = {
  apiKey: string;
  workspaceId: string;
  /** Default: https://useorgx.com */
  baseUrl?: string;
  /** Override for tests. */
  driver?: Driver;
  /** Skip the license heartbeat (tests). */
  skipHeartbeat?: boolean;
  /** Local Work Graph JSONL outbox path. Set false to disable. */
  workGraphOutboxPath?: string | false;
  /** Stable installation identity used to join heartbeat observations. */
  installationId?: string;
  /** MCP endpoint advertised in Chronicle health. */
  mcpEndpoint?: string;
  /** Override local replay state for tests. */
  continuityOutbox?: ContinuityOutboxHealth;
  /** Disable terminal replay for tests or intentionally offline installs. */
  autoReplayWorkGraph?: boolean;
};

export type StartedPeer = {
  stop: () => Promise<void>;
};

export async function startPeer(opts: StartPeerOptions): Promise<StartedPeer> {
  const baseUrl = opts.baseUrl ?? 'https://useorgx.com';
  const manifest = await loadManifest();
  initializePluginSentry(manifest.version);
  const replayWorkGraph =
    opts.autoReplayWorkGraph === false
      ? undefined
      : createWorkGraphReplay({
          apiKey: opts.apiKey,
          baseUrl,
          workspaceId: opts.workspaceId,
          outboxPath: opts.workGraphOutboxPath,
        });
  const driver =
    opts.driver ??
    new OpenCodeDriver({
      skillRules: async () => fetchSkillRules(baseUrl, opts),
      workGraphOutboxPath: opts.workGraphOutboxPath,
      replayWorkGraph,
    });

  let transportOnline = false;
  let presenceTimer: ReturnType<typeof setInterval> | null = null;
  const heartbeatPresence = () =>
    postPresenceHeartbeat(baseUrl, opts, manifest, driver, transportOnline);

  const client = new PeerClient({
    baseUrl: httpsToWss(baseUrl),
    apiKey: opts.apiKey,
    workspaceId: opts.workspaceId,
    pluginId: PLUGIN_ID,
    installationId: opts.installationId ?? defaultInstallationId(),
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    drivers: [driver],
    onOpen: () => {
      transportOnline = true;
      // eslint-disable-next-line no-console
      console.log('[orgx-opencode-plugin] connected');
      void heartbeatPresence().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[orgx-opencode-plugin] open heartbeat failed', err);
      });
    },
    onClose: (code, reason) => {
      transportOnline = false;
      // eslint-disable-next-line no-console
      console.warn('[orgx-opencode-plugin] closed', { code, reason });
    },
    onError: (err) => {
      capturePluginException(err, { stage: 'gateway_transport' });
      // eslint-disable-next-line no-console
      console.error('[orgx-opencode-plugin] error', err);
    },
  });
  client.connect();

  let licenseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (!opts.skipHeartbeat) {
    await heartbeatPresence().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[orgx-opencode-plugin] initial presence heartbeat failed', err);
    });
    presenceTimer = setInterval(() => {
      void heartbeatPresence().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[orgx-opencode-plugin] presence heartbeat failed', err);
      });
    }, PRESENCE_HEARTBEAT_MS);
    presenceTimer.unref?.();

    await postLicenseHeartbeat(baseUrl, opts, manifest).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[orgx-opencode-plugin] initial license heartbeat failed', err);
    });
    licenseHeartbeatTimer = setInterval(
      () => {
        void postLicenseHeartbeat(baseUrl, opts, manifest).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[orgx-opencode-plugin] weekly heartbeat failed', err);
        });
      },
      LICENSE_HEARTBEAT_MS
    );
    licenseHeartbeatTimer.unref?.();
  }

  return {
    stop: async () => {
      if (presenceTimer) clearInterval(presenceTimer);
      if (licenseHeartbeatTimer) clearInterval(licenseHeartbeatTimer);
      transportOnline = false;
      client.disconnect();
    },
  };
}

type Manifest = {
  plugin_name: string;
  version: string;
  manifest_fingerprint: string;
  signature: string;
};

async function loadManifest(): Promise<Manifest> {
  // Manifest lives at package root. Resolved via import.meta.url so ESM + CJS agree.
  const here = fileURLToPath(import.meta.url);
  const manifestPath = resolve(here, '../..', 'plugin.manifest.json');
  try {
    const raw = await readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch {
    // In dev, bail to a placeholder so the peer can still start. The
    // server will mark the license 'degraded' in permissive mode.
    return {
      plugin_name: '@useorgx/orgx-opencode-plugin',
      version: '0.0.0-dev',
      manifest_fingerprint: 'dev-placeholder',
      signature: '',
    };
  }
}

async function postPresenceHeartbeat(
  baseUrl: string,
  opts: StartPeerOptions,
  manifest: Manifest,
  driver: Driver,
  transportOnline: boolean
): Promise<void> {
  const detected = await driver.detect();
  const authenticated = detected.authenticated === true;
  const authState = authenticated
    ? 'authenticated'
    : detected.installed
      ? 'unauthenticated'
      : 'unavailable';
  const continuityHealth = await buildPluginContinuityHealth({
    version: manifest.version,
    authState,
    endpoint: opts.mcpEndpoint,
    outbox: opts.continuityOutbox,
  });
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/gateway/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      workspace_id: opts.workspaceId,
      plugin_id: PLUGIN_ID,
      installation_id: opts.installationId ?? defaultInstallationId(),
      host_platform: process.platform,
      drivers_installed: [driver.id],
      gateway_version: manifest.version,
      protocol_version: GATEWAY_PROTOCOL_VERSION,
      plan_tier: null,
      subscription_type: null,
      subscription_active: authenticated,
      metadata: {
        runtime: 'peer',
        transport_online: transportOnline,
        runtime_online: true,
        dispatch_ready:
          transportOnline && detected.installed === true && authenticated,
        auth_status: authState,
        auth_method: null,
        probe_version: detected.version ?? null,
        continuity_health: continuityHealth,
      },
    }),
  });
  if (!r.ok) {
    throw new Error(`presence heartbeat ${r.status}`);
  }
}

async function postLicenseHeartbeat(
  baseUrl: string,
  opts: StartPeerOptions,
  manifest: Manifest
): Promise<void> {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/licenses/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      workspace_id: opts.workspaceId,
      plugin_name: manifest.plugin_name,
      version: manifest.version,
      manifest_fingerprint: manifest.manifest_fingerprint,
      signature: manifest.signature,
    }),
  });
  if (!r.ok) {
    throw new Error(`heartbeat ${r.status}: ${await r.text().catch(() => '')}`);
  }
}

function defaultInstallationId(): string {
  return `${PLUGIN_ID}:${process.platform}:${process.env.USER ?? 'local'}`;
}

async function fetchSkillRules(
  baseUrl: string,
  opts: StartPeerOptions
): Promise<
  Array<{
    skill_id: string;
    match: { pattern: string; on: 'file_edit' | 'tool_call' };
    dedupe_fingerprint: string;
    evidence_kind: string;
  }>
> {
  try {
    const r = await fetch(
      `${baseUrl.replace(/\/$/, '')}/api/v1/plan-skills?workspace_id=${encodeURIComponent(opts.workspaceId)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${opts.apiKey}` },
      }
    );
    if (!r.ok) return [];
    const body = (await r.json()) as {
      skills?: Array<{
        id: string;
        rules?: Array<{
          pattern: string;
          on: 'file_edit' | 'tool_call';
          dedupe_fingerprint: string;
          evidence_kind: string;
        }>;
      }>;
    };
    const rules: Array<{
      skill_id: string;
      match: { pattern: string; on: 'file_edit' | 'tool_call' };
      dedupe_fingerprint: string;
      evidence_kind: string;
    }> = [];
    for (const skill of body.skills ?? []) {
      for (const rule of skill.rules ?? []) {
        rules.push({
          skill_id: skill.id,
          match: { pattern: rule.pattern, on: rule.on },
          dedupe_fingerprint: rule.dedupe_fingerprint,
          evidence_kind: rule.evidence_kind,
        });
      }
    }
    return rules;
  } catch {
    return [];
  }
}

function httpsToWss(url: string): string {
  if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length);
  if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length);
  return url;
}
