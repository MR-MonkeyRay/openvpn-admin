import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('lint script runs real syntax checks for source, tests and scripts', () => {
  const lintScript = packageJson.scripts?.lint;

  assert.equal(typeof lintScript, 'string');
  assert.notEqual(lintScript.includes('No linter configured'), true);
  assert.match(lintScript, /node --check/);
  assert.match(lintScript, /src/);
  assert.match(lintScript, /tests/);
  assert.match(lintScript, /scripts/);
});

test('package scripts expose lightweight preflight and healthcheck commands', () => {
  const preflightScript = packageJson.scripts?.preflight;
  const healthcheckScript = packageJson.scripts?.healthcheck;

  assert.equal(typeof preflightScript, 'string');
  assert.equal(typeof healthcheckScript, 'string');
  assert.match(preflightScript, /ensureProductionRuntimeConfig/);
  assert.match(healthcheckScript, /\/health/);
  assert.match(healthcheckScript, /curl -fsS/);
});
