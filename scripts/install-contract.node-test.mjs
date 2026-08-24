import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
const readme = readFileSync(readmePath, 'utf8');

test('prerelease install examples select the current alpha channel explicitly', () => {
  assert.match(
    readme,
    /"plugin": \["@useorgx\/orgx-opencode-plugin@alpha"\]/,
    'opencode.json must select the alpha dist-tag'
  );
  assert.match(readme, /npm install -g @useorgx\/orgx-opencode-plugin@alpha/);
  assert.match(readme, /pnpm add -g @useorgx\/orgx-opencode-plugin@alpha/);

  assert.doesNotMatch(
    readme,
    /"plugin": \["@useorgx\/orgx-opencode-plugin"\]/,
    'an untagged plugin entry can resolve npm\'s stale default tag'
  );
  assert.doesNotMatch(
    readme,
    /(?:npm install|pnpm add) -g @useorgx\/orgx-opencode-plugin(?:\s|$)/,
    'global prerelease installs must not use the untagged package'
  );
});
