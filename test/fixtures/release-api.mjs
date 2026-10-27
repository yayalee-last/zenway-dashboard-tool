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
const calls = [];
const published = {
  id: 123,
  tag_name: `v${pkg.version}`,
  draft: false,
  prerelease: false,
  published_at: '2026-10-27T08:08:18Z',
  html_url: `${api.replace('api.github.com/repos', 'github.com')}/releases/tag/v${pkg.version}`,
};

// 只替代本次发版的三个产物；不读写真实 release 目录，也不执行打包。
fs.existsSync = (file) => archivePaths.includes(file) || file === manifestPath || existsSync(file);
fs.readFileSync = (file, ...args) => {
  if (archivePaths.includes(file)) return Buffer.from('test archive');
  if (file === manifestPath) return JSON.stringify({ version: pkg.version });
  return readFileSync(file, ...args);
};
syncBuiltinESMExports();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
globalThis.fetch = async (url, options = {}) => {
  if (url === `${api}/releases` && options.method === 'POST') {
    calls.push('create');
    return json({ ...published, draft: true, published_at: null, upload_url: `${upload}{?name,label}` });
  }
  if (url.startsWith(`${upload}?name=`) && options.method === 'POST') {
    const name = new URL(url).searchParams.get('name');
    calls.push(`upload:${name}`);
    return scenario === 'upload-failed' ? json({ message: 'upload failed' }, 500) : json({ name });
  }
  if (url === `${api}/releases/123` && options.method === 'PATCH') {
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
    return json({ errcode: 0 });
  }
  throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
};

process.on('exit', () => console.log(`RELEASE_TEST_CALLS=${JSON.stringify(calls)}`));
