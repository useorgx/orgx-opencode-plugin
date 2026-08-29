import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const readme = readFileSync(readmePath, 'utf8');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

const UNSAFE_RUNTIME_DEPENDENCY = /^(?:git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|file:|link:|workspace:)/i;

test('runtime dependencies are installable by OpenCode without Git preparation', () => {
  const dependencies = packageJson.dependencies ?? {};
  assert.equal(
    dependencies['@useorgx/orgx-gateway-sdk'],
    '0.1.0-alpha.12',
    'the Gateway SDK must use the published alpha.12 package instead of a Git checkout'
  );

  for (const [name, specifier] of Object.entries(dependencies)) {
    assert.equal(typeof specifier, 'string', `${name} must use a string dependency specifier`);
    assert.doesNotMatch(
      specifier,
      UNSAFE_RUNTIME_DEPENDENCY,
      `${name} uses ${specifier}; OpenCode clean-home installs cannot prepare Git or local runtime dependencies`
    );
    assert.doesNotMatch(
      specifier,
      /\.git(?:#|$)/i,
      `${name} uses ${specifier}; publish the dependency to npm before releasing this plugin`
    );
  }
});

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
