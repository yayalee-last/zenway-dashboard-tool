'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('Windows widget keeps its pin through window changes and idle refresh', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-window-test-'));
  t.after(() => fs.promises.rm(output, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const env = { ...process.env, ZT_WINDOW_TEST_DIR: output };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await execFileAsync(require('electron'), [path.join(__dirname, 'fixtures/window-lifecycle.cjs')], {
      env, windowsHide: true, timeout: 50000,
    });
  } catch (error) {
    const report = path.join(output, 'result.json');
    if (fs.existsSync(report)) error.message += '\n' + fs.readFileSync(report, 'utf8');
    throw error;
  }
  const result = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
  assert.equal(result.passed, true);
  assert.equal(result.samples.length, 5);
});