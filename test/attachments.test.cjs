'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ZentaoClient } = require('../electron/zentao');

const largeFile = Buffer.alloc(5 * 1024 * 1024, 0x61);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/qcAAAAASUVORK5CYII=', 'base64');

async function fixture(t, { download, openPath, detailStatus = 200, title = '附件.txt' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-attachments-test-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const requests = [], opened = [];
  const detail = { id: 119, name: 'Task', title: 'Bug', status: 'doing',
    desc: '<p>description</p>', steps: '<p>steps</p>',
    files: { 180: { id: 180, title, extension: 'txt', pathname: '../../server-path', url: 'https://example.invalid/download' } } };
  let tokenCount = 0;
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, token: req.headers.token, cookie: req.headers.cookie });
    if (req.url === '/api.php/v1/tokens') {
      tokenCount++;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: 'fixture-token-' + tokenCount }));
    } else if (/^\/api.php\/v1\/(tasks|bugs)\/119$/.test(req.url)) {
      res.writeHead(detailStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(detailStatus === 200 ? detail : { error: 'denied' }));
    } else if (req.url === '/api.php/v1/files/181') {
      res.writeHead(200, { 'Content-Disposition': 'attachment; filename="image.png"' });
      res.end(png);
    } else if (download) download(req, res);
    else {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="server-name.txt"' });
      res.end(largeFile);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const client = new ZentaoClient({ baseUrl: 'http://127.0.0.1:' + server.address().port, account: 'fixture', password: 'fixture', timeoutMs: 1000 });
  const handlers = new Map();
  const electron = {
    app: { setName() {}, getPath: () => directory, requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    shell: { async openPath(file) { opened.push(file); return openPath ? openPath(file) : ''; },
      openExternal() { assert.fail('attachments must not use the browser'); } },
  };
  const source = path.resolve(__dirname, '../electron/main.js'), realRequire = createRequire(source);
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : realRequire(name),
    module: { exports: {} }, __dirname: path.dirname(source), process: { argv: [], platform: process.platform },
    Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8') + '\nmodule.exports = { setup(c) { client = c; config = c.cfg; wireIpc(); } };', context, { filename: source });
  context.module.exports.setup(client);
  return { client, directory, detail, requests, opened, handlers,
    invoke: (name, value) => handlers.get(name)(null, value),
    open: (kind = 'task', extra = {}) => handlers.get('attachment:open')(null, { kind, id: 119, fileId: 180, ...extra }) };
}

test('task and bug details pass observed file-ID maps as attachment names and IDs', async t => {
  const f = await fixture(t);
  for (const kind of ['task', 'bug']) {
    const result = await f.invoke(kind + ':detail', 119);
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result[kind].files)), [{ id: 180, name: '附件.txt' }]);
    assert.match(result[kind][kind === 'task' ? 'desc' : 'steps'], /description|steps/);
  }
  f.detail.files = [];
  assert.equal((await f.invoke('task:detail', 119)).task.files.length, 0);
  assert.equal((await f.invoke('bug:detail', 119)).bug.files.length, 0);
});

test('both attachment kinds download over 4 MiB with Token and open complete local files', async t => {
  const f = await fixture(t);
  for (const kind of ['task', 'bug']) {
    assert.equal((await f.open(kind)).ok, true);
    assert.deepEqual(fs.readFileSync(f.opened.at(-1)), largeFile);
  }
  assert.notEqual(f.opened[0], f.opened[1]);
  for (const request of f.requests.filter(r => r.url.includes('/files/'))) {
    assert.equal(request.url, '/api.php/v1/files/180');
    assert.match(request.token, /^fixture-token-/);
    assert.equal(request.cookie, undefined);
  }
  assert.equal(await f.client.fetchFileDataUrl(181), 'data:image/png;base64,' + png.toString('base64'));
});

test('expired Token is renewed once for file downloads', async t => {
  let calls = 0;
  const f = await fixture(t, { download(req, res) {
    if (++calls === 1) { res.writeHead(401); res.end(); }
    else { res.writeHead(200, { 'Content-Disposition': 'attachment; filename="a.txt"' }); res.end('ok'); }
  } });
  assert.equal((await f.open()).ok, true);
  assert.equal(calls, 2);
  assert.equal(f.requests.filter(r => r.url.endsWith('/tokens')).length, 2);
  assert.equal(fs.readFileSync(f.opened[0], 'utf8'), 'ok');
});

for (const [name, status, headers, content, expected] of [
  ['permission denied', 403, {}, 'denied', /无权限/],
  ['missing file', 404, {}, 'missing', /HTTP 404/],
  ['API error', 500, {}, 'error', /HTTP 500/],
  ['login page returned as 200', 200, { 'Content-Type': 'text/html' }, '<html>login</html>', /接口未返回文件.*登录状态/],
  ['JSON error returned as 200', 200, { 'Content-Type': 'application/json' }, '{"error":"denied"}', /接口未返回文件.*权限/],
  ['redirect', 302, { Location: '/must-not-follow' }, '', /下载附件失败/],
]) {
  test(name + ' is reported without opening a file or exposing server data', async t => {
    const f = await fixture(t, { download(req, res) { res.writeHead(status, headers); res.end(content); } });
    const result = await f.open();
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.equal(f.opened.length, 0);
    assert.deepEqual(fs.readdirSync(f.directory), []);
    assert.equal(f.requests.some(r => r.url === '/must-not-follow'), false);
    assert(!result.error.includes('fixture-token'));
  });
}

test('interrupted downloads are reported and partial files are removed', async t => {
  const f = await fixture(t, { download(req, res) {
    res.writeHead(200, { 'Content-Disposition': 'attachment; filename="a.txt"', 'Content-Length': '10000' });
    res.write('incomplete');
    setImmediate(() => res.destroy());
  } });
  assert.match((await f.open()).error, /下载附件失败/);
  assert.equal(f.opened.length, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('detail permission failures and attachments outside the object are rejected', async t => {
  const f = await fixture(t, { detailStatus: 403 });
  assert.match((await f.invoke('task:detail', 119)).error, /403/);
  assert.match((await f.open()).error, /读取附件信息失败：无权限/);
  assert.equal(f.opened.length, 0);
  const allowed = await fixture(t);
  assert.match((await allowed.open('bug', { fileId: 999 })).error, /已无该附件/);
  assert.match((await allowed.open('other')).error, /请求无效/);
  assert.match((await allowed.open('task', { fileId: '../180' })).error, /请求无效/);
  assert.equal(allowed.requests.some(r => r.url.includes('/files/')), false);
});

test('system-open failures and rejections produce a clear local-open error', async t => {
  for (const openPath of [() => 'No associated application', () => { throw new Error('private-system-detail'); }]) {
    const f = await fixture(t, { openPath });
    const result = await f.open();
    assert.equal(result.ok, false);
    assert.match(result.error, /本地打开附件失败.*默认程序/);
    assert(!result.error.includes('private-system-detail'));
    assert.deepEqual(fs.readdirSync(f.directory), []);
  }
});

test('external names stay inside unique directories and ignore renderer paths', async t => {
  const f = await fixture(t);
  for (const title of ['../../outside.txt', '..\\..\\outside.txt', 'C:\\outside:stream.txt', 'CON.txt', 'NUL', ' . ', 'a'.repeat(300) + '.xlsx']) {
    f.detail.files[180].title = title;
    assert.equal((await f.open('task', { name: '../untrusted.exe', url: 'https://example.invalid', path: '../untrusted' })).ok, true);
    const file = f.opened.at(-1), relative = path.relative(f.directory, file);
    assert(!relative.startsWith('..'));
    assert.equal(relative.split(path.sep).length, 2);
    assert.equal(path.basename(path.dirname(file)).startsWith('zentao-attachment-'), true);
    assert(path.basename(file).length <= 180);
    assert(!/[<>:"/\\|?*]/.test(path.basename(file)));
    assert(!/^(con|nul)(\.|$)/i.test(path.basename(file)));
  }
  await Promise.all([f.open(), f.open()]);
  assert.equal(new Set(f.opened).size, f.opened.length);
});

test('real Electron renders both attachment lists and routes clicks and errors through preload', { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-attachment-ui-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { ...process.env, ZT_ATTACHMENT_TEST_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await promisify(execFile)(require('electron'), [path.join(__dirname, 'fixtures/attachments.cjs')], { env, windowsHide: true, timeout: 15000 });
  } catch (error) {
    const report = path.join(directory, 'result.json');
    if (fs.existsSync(report)) error.message += '\n' + fs.readFileSync(report, 'utf8');
    throw error;
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8')).passed, true);
});
