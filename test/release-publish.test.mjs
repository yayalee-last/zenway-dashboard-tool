import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishedCalls = [
  'create',
  'upload:ZentaoWidget-win32-x64.zip',
  'upload:ZentaoWidget-app.zip',
  'upload:ZentaoWidget-update.json',
  'publish',
];

function runRelease(scenario) {
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(path.join(root, 'test/fixtures/release-api.mjs')).href,
    path.join(root, 'scripts/release.mjs'), '--skip-pack',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      GITHUB_TOKEN: 'test-token',
      WECOM_WEBHOOK_URL: 'https://example.invalid/wecom',
      RELEASE_TEST_SCENARIO: scenario,
    },
  });
  assert.ifError(result.error);
  const match = result.stdout.match(/^RELEASE_TEST_CALLS=(.+)$/m);
  assert.ok(match, result.stderr);
  return { ...result, calls: JSON.parse(match[1]), output: result.stdout + result.stderr };
}

test('正常公开 Release 后只通知一次，不额外查询', () => {
  const result = runRelease('normal');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [...publishedCalls, 'notify']);
});

test('GitHub 返回 500 但实际已公开时，核对状态后继续通知一次', () => {
  const result = runRelease('500-published');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [...publishedCalls, 'verify', 'notify']);
});

test('公开请求网络异常但实际已公开时，同样核对后继续通知', () => {
  const result = runRelease('network-published');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [...publishedCalls, 'verify', 'notify']);
});

test('核对后仍是草稿则报错，不重复发布或发送通知', () => {
  const result = runRelease('still-draft');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.calls, [...publishedCalls, 'verify']);
});

test('无法核对发布状态时明确报错，不宣称草稿已保留或发送通知', () => {
  const result = runRelease('verify-failed');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.calls, [...publishedCalls, 'verify']);
  assert.match(result.output, /无法核对/);
  assert.doesNotMatch(result.output, /草稿已保留/);
});

test('上传附件失败时直接失败，不公开或核对公开状态', () => {
  const result = runRelease('upload-failed');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.calls, ['create', 'upload:ZentaoWidget-win32-x64.zip']);
});

test('异常后核对为预发布时仍不发送企微通知', () => {
  const result = runRelease('prerelease');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [...publishedCalls, 'verify']);
});
