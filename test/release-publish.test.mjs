import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentNotes = '### 修复\n\n- 子任务在挂件内打开详情。\n- 参考任务保持只读。';
const versionTag = `v${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`;
const publishedCalls = [
  'create',
  'upload:ZentaoWidget-win32-x64.zip',
  'upload:ZentaoWidget-app.zip',
  'upload:ZentaoWidget-update.json',
  'publish',
];

function runRelease(scenario, extraArgs = [], script = 'release.mjs') {
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(path.join(root, 'test/fixtures/release-api.mjs')).href,
    path.join(root, 'scripts', script),
    ...(script === 'release.mjs' ? ['--skip-pack'] : []),
    ...extraArgs,
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
  const match = result.stdout.match(/^RELEASE_TEST_RESULT=(.+)$/m);
  assert.ok(match, result.stderr);
  return { ...result, ...JSON.parse(match[1]), output: result.stdout + result.stderr };
}

test('从 CHANGELOG 对应版本提取更新内容并随正式通知发送一次', () => {
  const result = runRelease('normal');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [...publishedCalls, 'notify']);
  assert.equal(result.notes, currentNotes);
  assert.ok(result.notification.includes(currentNotes));
  assert.doesNotMatch(result.notification, /下个版本|旧版本|自动打包/);
});

test('显式 --note 仍可覆盖 CHANGELOG 的更新说明', () => {
  const result = runRelease('normal', ['--note', '- 明确指定的更新内容']);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.notes, '- 明确指定的更新内容');
  assert.ok(result.notification.includes(result.notes));
});

for (const scenario of ['missing-notes', 'empty-notes']) {
  test(scenario + ' 在创建 Release 前停止', () => {
    const result = runRelease(scenario);
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(result.calls, []);
    assert.match(result.output, /CHANGELOG.*更新内容/);
  });
}

test('空的 --note 在创建 Release 前停止', () => {
  const result = runRelease('normal', ['--note', '   ']);
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /发布说明不能为空/);
});

test('GitHub 返回 500 但实际已公开时，核对状态后继续通知一次', () => {
  const result = runRelease('500-published');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [...publishedCalls, 'verify', 'notify']);
  assert.ok(result.notification.includes(currentNotes));
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

test('已发布版本先补全说明，再补发一次企微，不创建 Release 或上传附件', () => {
  const result = runRelease('notify-normal', [versionTag], 'notify-release.mjs');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, ['lookup', 'update-notes', 'notify']);
  assert.equal(result.notes, currentNotes);
  assert.ok(result.notification.includes(currentNotes));
});

test('补发入口拒绝草稿，不改说明或发消息', () => {
  const result = runRelease('notify-draft', [versionTag], 'notify-release.mjs');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.calls, ['lookup']);
});

test('说明更新失败后停止，不发送企微', () => {
  const result = runRelease('notify-patch-failed', [versionTag], 'notify-release.mjs');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.calls, ['lookup', 'update-notes']);
});

test('企微失败不重试，也不重复编辑发布说明', () => {
  const result = runRelease('notify-wecom-failed', [versionTag], 'notify-release.mjs');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.calls, ['lookup', 'update-notes', 'notify']);
});

test('补发入口拒绝无效版本号，不发出请求', () => {
  const result = runRelease('notify-normal', ['../v0.3.13'], 'notify-release.mjs');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.calls, []);
});
