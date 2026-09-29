import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeAbsoluteHostPath } from './hostPath';

describe('normalizeAbsoluteHostPath', () => {
  it('normalizes a drive-qualified Windows path and uppercases its drive', () => {
    expect(
      normalizeAbsoluteHostPath('c:\\work\\repo\\..\\orgx', 'win32')
    ).toBe('C:\\work\\orgx');
  });

  it('accepts and normalizes a Windows UNC path', () => {
    expect(
      normalizeAbsoluteHostPath(
        '\\\\server\\share\\repo\\..\\orgx',
        'win32'
      )
    ).toBe('\\\\server\\share\\orgx');
  });

  it.each(['\\repo', '/repo', 'c:repo', '\\\\server', '//server'])(
    'rejects the non-qualified Windows path %s',
    (candidate) => {
      expect(normalizeAbsoluteHostPath(candidate, 'win32')).toBeNull();
    }
  );

  it.each([
    '\\\\?\\C:\\repo',
    '\\\\.\\C:\\repo',
    '\\\\??\\C:\\repo',
    '//?/C:/repo',
    '//./C:/repo',
  ])('rejects the Windows device namespace path %s', (candidate) => {
    expect(normalizeAbsoluteHostPath(candidate, 'win32')).toBeNull();
  });

  it('keeps POSIX absolute-path behavior', () => {
    expect(normalizeAbsoluteHostPath('/work/repo/../orgx', 'linux')).toBe(
      '/work/orgx'
    );
    expect(normalizeAbsoluteHostPath('/work/orgx/', 'darwin')).toBe(
      '/work/orgx'
    );
    expect(normalizeAbsoluteHostPath('work/orgx', 'linux')).toBeNull();
  });

  it('canonicalizes a POSIX symlink alias through its longest existing ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'orgx-opencode-path-'));
    const physical = join(root, 'physical');
    const alias = join(root, 'alias');
    mkdirSync(physical);
    symlinkSync(physical, alias, 'dir');
    try {
      expect(normalizeAbsoluteHostPath(join(alias, 'future', 'repo'))).toBe(
        join(realpathSync.native(physical), 'future', 'repo')
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
