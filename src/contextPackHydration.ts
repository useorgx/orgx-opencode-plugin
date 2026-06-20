/**
 * Context-pack hydration (M adapter — OpenCode).
 *
 * On session connect, fetches the compiled AgentContextPack for the active
 * initiative (POST /api/client/context-pack) and writes .opencode/
 * orgx-context-pack.json (0600) so the agent starts briefed. Best-effort — never
 * throws. The MCP backbone also returns the pack on first orgx_inspect call, so
 * hydration is guaranteed either way.
 */
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

export interface ContextPackConfig {
  apiKey: string;
  baseUrl: string;
  initiativeId: string;
}

export function resolveContextPackConfig(env: Env): ContextPackConfig | null {
  const apiKey = env.ORGX_API_KEY?.trim();
  const baseUrl = env.ORGX_BASE_URL?.trim() || 'https://useorgx.com';
  const initiativeId = env.ORGX_INITIATIVE_ID?.trim();
  if (!apiKey || !initiativeId) return null;
  return { apiKey, baseUrl, initiativeId };
}

export function buildContextPackRequest(config: ContextPackConfig): {
  url: string;
  init: RequestInit;
} {
  return {
    url: `${config.baseUrl.replace(/\/$/, '')}/api/client/context-pack`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ initiative_id: config.initiativeId }),
    },
  };
}

export async function hydrateContextPack(env: Env = process.env): Promise<boolean> {
  try {
    const config = resolveContextPackConfig(env);
    if (!config) return false;
    const { url, init } = buildContextPackRequest(config);
    const res = await fetch(url, init);
    if (!res.ok) return false;
    const payload = (await res.json().catch(() => null)) as { data?: unknown } | null;
    const data = payload?.data ?? null;
    if (!data) return false;
    const dir = join(process.cwd(), '.opencode');
    await mkdir(dir, { recursive: true });
    const out = join(dir, 'orgx-context-pack.json');
    await writeFile(
      out,
      JSON.stringify({ fetchedAt: new Date().toISOString(), data }, null, 2),
      { mode: 0o600 }
    );
    await chmod(out, 0o600).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
