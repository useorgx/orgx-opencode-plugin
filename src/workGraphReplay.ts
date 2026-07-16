import { execFile } from 'child_process';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export type WorkGraphReplayOptions = {
  apiKey: string;
  baseUrl: string;
  workspaceId: string;
  outboxPath?: string | false;
  reportPath?: string;
};

export function createWorkGraphReplay(
  opts: WorkGraphReplayOptions
): () => Promise<void> {
  return async () => {
    if (opts.outboxPath === false) return;
    const here = dirname(fileURLToPath(import.meta.url));
    const script = resolve(here, '..', 'scripts', 'orgx-work-graph-reconcile.mjs');
    const reportPath =
      opts.reportPath ??
      process.env.ORGX_WIZARD_HOOK_REPORT_OUTPUT ??
      join(
        homedir(),
        '.config',
        'useorgx',
        'wizard',
        'hooks',
        'reports',
        'latest-work-graph-report.json'
      );
    const args = [
      script,
      '--post',
      `--output=${reportPath}`,
      `--workspace-id=${opts.workspaceId}`,
    ];
    if (typeof opts.outboxPath === 'string' && opts.outboxPath.trim()) {
      args.push(`--outbox=${opts.outboxPath}`);
    }

    await new Promise<void>((resolvePromise, reject) => {
      execFile(
        process.execPath,
        args,
        {
          env: {
            ...process.env,
            ORGX_API_KEY: opts.apiKey,
            ORGX_BASE_URL: opts.baseUrl,
          },
          timeout: 15_000,
          windowsHide: true,
        },
        (error) => {
          if (error) reject(error);
          else resolvePromise();
        }
      );
    });
  };
}
