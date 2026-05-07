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

import { OpenCodeDriver } from './OpenCodeDriver';

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
};

export type StartedPeer = {
  stop: () => Promise<void>;
};

export async function startPeer(opts: StartPeerOptions): Promise<StartedPeer> {
  const baseUrl = opts.baseUrl ?? 'https://useorgx.com';
  const driver =
    opts.driver ??
    new OpenCodeDriver({
      skillRules: async () => fetchSkillRules(baseUrl, opts),
      workGraphOutboxPath: opts.workGraphOutboxPath,
    });

  const manifest = await loadManifest();

  const client = new PeerClient({
    baseUrl: httpsToWss(baseUrl),
    apiKey: opts.apiKey,
    workspaceId: opts.workspaceId,
    pluginId: '@useorgx/orgx-opencode-plugin',
    drivers: [driver],
    onOpen: () => {
      // eslint-disable-next-line no-console
      console.log('[orgx-opencode-plugin] connected');
    },
    onClose: (code, reason) => {
      // eslint-disable-next-line no-console
      console.warn('[orgx-opencode-plugin] closed', { code, reason });
    },
    onError: (err) => {
      // eslint-disable-next-line no-console
      console.error('[orgx-opencode-plugin] error', err);
    },
  });
  client.connect();

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (!opts.skipHeartbeat) {
    await postHeartbeat(baseUrl, opts, manifest).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[orgx-opencode-plugin] initial heartbeat failed', err);
    });
    heartbeatTimer = setInterval(
      () => {
        void postHeartbeat(baseUrl, opts, manifest).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[orgx-opencode-plugin] weekly heartbeat failed', err);
        });
      },
      7 * 24 * 60 * 60 * 1000
    );
  }

  return {
    stop: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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

async function postHeartbeat(
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
