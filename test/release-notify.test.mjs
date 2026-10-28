import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyWecomRelease } from '../scripts/release-notify.mjs';

const webhookUrl = 'https://example.invalid/webhook?key=test-only';
const release = {
  tag_name: 'v1.2.3',
  html_url: 'https://github.com/example/project/releases/tag/v1.2.3',
  body: '- 子任务在挂件内打开详情。\n- 参考任务保持只读。',
  draft: false,
  prerelease: false,
  published_at: '2026-10-27T00:00:00Z',
};

test('草稿、预发布和未发布 Release 不请求企微', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', () => { throw new Error('不应发出请求'); });
  for (const changed of [{ draft: true }, { prerelease: true }, { published_at: null }]) {
    assert.equal(await notifyWecomRelease({ ...release, ...changed }, webhookUrl), false);
  }
  assert.equal(request.mock.callCount(), 0);
});

test('未配置 Secret 时跳过通知', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', () => { throw new Error('不应发出请求'); });
  assert.equal(await notifyWecomRelease(release, undefined), false);
  assert.equal(request.mock.callCount(), 0);
});

test('正式版发送一次文本通知，包含本次更新、版本和下载链接', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ errcode: 0 })));
  assert.equal(await notifyWecomRelease(release, webhookUrl), true);
  assert.equal(request.mock.callCount(), 1);
  const [url, options] = request.mock.calls[0].arguments;
  assert.equal(url, webhookUrl);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), {
    msgtype: 'text',
    text: { content: `禅道挂件正式版已发布\n版本：v1.2.3\n本次更新：\n${release.body}\n下载与完整更新说明：${release.html_url}` },
  });
  assert.ok(!options.body.includes('test-only'));
});

test('HTTP 失败不输出响应正文或重试', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(webhookUrl, { status: 503 }));
  await assert.rejects(notifyWecomRelease(release, webhookUrl), { message: '企微返回 HTTP 503' });
  assert.equal(request.mock.callCount(), 1);
});

test('企微业务错误只输出错误码', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ errcode: 93000, errmsg: webhookUrl })));
  await assert.rejects(notifyWecomRelease(release, webhookUrl), { message: '企微返回错误码 93000' });
});

test('网络失败不泄漏带 key 的原始异常', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(webhookUrl); });
  await assert.rejects(notifyWecomRelease(release, webhookUrl), {
    message: '企微请求失败或超时，请检查网络及 WECOM_WEBHOOK_URL',
  });
});

test('响应无法解析时不输出正文', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(webhookUrl));
  await assert.rejects(notifyWecomRelease(release, webhookUrl), { message: '企微返回了无效 JSON' });
});

test('缺少更新内容时不发送空摘要消息', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', () => { throw new Error('不应发出请求'); });
  for (const body of [null, '', '   ']) {
    await assert.rejects(notifyWecomRelease({ ...release, body }, webhookUrl), /缺少更新内容/);
  }
  assert.equal(request.mock.callCount(), 0);
});

test('超长中文和 emoji 摘要只发送一次，按 UTF-8 字节限制并保留完整说明链接', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ errcode: 0 })));
  await notifyWecomRelease({ ...release, body: '修复子任务🎉'.repeat(400) }, webhookUrl);
  assert.equal(request.mock.callCount(), 1);
  const content = JSON.parse(request.mock.calls[0].arguments[1].body).text.content;
  assert.ok(Buffer.byteLength(content, 'utf8') <= 2048);
  assert.match(content, /修复子任务🎉/);
  assert.match(content, /更新内容较长/);
  assert.ok(content.endsWith(release.html_url));
  assert.ok(!content.includes('\uFFFD'));
});
