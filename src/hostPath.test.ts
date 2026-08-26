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
});
