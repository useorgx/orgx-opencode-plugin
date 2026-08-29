import { platform as runtimePlatform } from 'node:os';
import { posix, win32 } from 'node:path';

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE = /^[\\/]{2}(?![?.][\\/])[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/;
const WINDOWS_DEVICE_NAMESPACE = /^[\\/]{1,2}(?:[?.][\\/]|\?\?[\\/])/;

/**
 * Canonicalize an absolute path using the selected host's path contract.
 *
 * Node considers drive-root-relative and device namespace paths absolute on
 * Windows. Neither identifies a stable repository cwd, so exact-session
 * identity accepts only drive-qualified paths and conventional UNC shares.
 */
export function normalizeAbsoluteHostPath(
  value: unknown,
  hostPlatform: NodeJS.Platform = runtimePlatform()
): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  if (hostPlatform !== 'win32') {
    return posix.isAbsolute(value) ? posix.resolve(value) : null;
  }

  if (
    WINDOWS_DEVICE_NAMESPACE.test(value) ||
    (!WINDOWS_DRIVE_ABSOLUTE.test(value) &&
      !WINDOWS_UNC_ABSOLUTE.test(value))
  ) {
    return null;
  }

  const normalized = win32.resolve(value);
  return normalized.replace(/^([a-z]):/, (_, drive: string) =>
    `${drive.toUpperCase()}:`
  );
}
