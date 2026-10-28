import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readFileSync = fs.readFileSync;
const existsSync = fs.existsSync;
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const scenario = process.env.RELEASE_TEST_SCENARIO;
const api = 'https://api.github.com/repos/yayalee-last/zenway-dashboard-tool';
const upload = 'https://uploads.github.com/repos/yayalee-last/zenway-dashboard-tool/releases/123/assets';
const archivePaths = ['ZentaoWidget-win32-x64.zip', 'ZentaoWidget-app.zip'].map((name) => path.join(root, 'release', name));
const manifestPath = path.join(root, 'release', 'ZentaoWidget-update.json');
const changelogPath = path.join(root, 'CHANGELOG.md');
const notes = '### 修复\n\n- 子任务在挂件内打开详情。\n- 参考任务保持只读。';
const calls = [];
let notification = null;
const published = {
  id: 123,
  tag_name: `v${pkg.version}`,
  body: 'GitHub Actions 自动打包',
  draft: false,
  prerelease: false,
  published_at: '2026-10-27T08:08:18Z',
  html_url: `${api.replace('api.github.com/repos', 'github.com')}/releases/tag/v${pkg.version}`,
};

// 产物、发布说明和全部请求均为替身，不打包、不访问真实 GitHub/企微。
fs.existsSync = (file) => archivePaths.includes(file) || file === manifestPath || existsSync(file);
fs.readFileSync = (file, ...args) => {
  if (archivePaths.includes(file)) return Buffer.from('test archive');
  if (file === manifestPath) return JSON.stringify({ version: pkg.version });
  if (file === changelogPath || file instanceof URL && fileURLToPath(file) === changelogPath) return [
    '# 变更记录', '', '## 未发布', '', '- 下个版本内容。', '',
    `## [${scenario === 'missing-notes' ? '9.9.9' : pkg.version}](https://example.invalid/compare) — 2026-10-28`,
    '', scenario === 'empty-notes' ? '' : notes, '', '## [0.0.1] — 2026-01-01', '', '- 旧版本内容。',
  ].join('\r\n');
  return readFileSync(file, ...args);
};
syncBuiltinESMExports();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
globalThis.fetch = async (url, options = {}) => {
  if (url === `${api}/releases` && options.method === 'POST') {
    calls.push('create');
    published.body = JSON.parse(options.body).body;
    return json({ ...published, draft: true, published_at: null, upload_url: `${upload}{?name,label}` });
  }
  if (url.startsWith(`${upload}?name=`) && options.method === 'POST') {
    const name = new URL(url).searchParams.get('name');
    calls.push(`upload:${name}`);
    return scenario === 'upload-failed' ? json({ message: 'upload failed' }, 500) : json({ name });
  }
  if (url === `${api}/releases/tags/v${pkg.version}` && !options.method) {
    calls.push('lookup');
    return json({ ...published, draft: scenario === 'notify-draft' });
  }
  if (url === `${api}/releases/123` && options.method === 'PATCH') {
    const patch = JSON.parse(options.body);
    if ('body' in patch) {
      calls.push('update-notes');
      if (scenario === 'notify-patch-failed') return json({ message: 'denied' }, 403);
      published.body = patch.body;
      return json(published);
    }
    calls.push('publish');
    if (scenario === 'normal') return json(published);
    if (scenario === 'network-published') throw new TypeError('fetch failed');
    return new Response('', { status: 500 });
  }
  if (url === `${api}/releases/123` && !options.method) {
    calls.push('verify');
    if (scenario === 'verify-failed') return json({ message: 'unavailable' }, 503);
    if (scenario === 'still-draft') return json({ ...published, draft: true, published_at: null });
    return json({ ...published, prerelease: scenario === 'prerelease' });
  }
  if (url === 'https://example.invalid/wecom' && options.method === 'POST') {
    calls.push('notify');
    notification = JSON.parse(options.body).text.content;
    return json({ errcode: scenario === 'notify-wecom-failed' ? 93000 : 0 });
  }
  throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
};

process.on('exit', () => console.log(`RELEASE_TEST_RESULT=${JSON.stringify({ calls, notes: published.body, notification })}`));
