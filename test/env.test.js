import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadDotEnv } from '../src/env.js';

test('a missing .env file is ignored (regression: `node --watch` crashed on it)', () => {
  assert.equal(loadDotEnv(join(tmpdir(), 'definitely-missing-dir', '.env')), false);
});

test('.env values are loaded, but never override the real environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
  try {
    const file = join(dir, '.env');
    writeFileSync(file, 'ENV_TEST_FROM_FILE=file\nENV_TEST_PRESET=file\n');
    process.env.ENV_TEST_PRESET = 'shell';
    assert.equal(loadDotEnv(file), true);
    assert.equal(process.env.ENV_TEST_FROM_FILE, 'file');
    assert.equal(process.env.ENV_TEST_PRESET, 'shell');
  } finally {
    delete process.env.ENV_TEST_FROM_FILE;
    delete process.env.ENV_TEST_PRESET;
    rmSync(dir, { recursive: true, force: true });
  }
});
