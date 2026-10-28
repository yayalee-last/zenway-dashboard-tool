'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { safeExternalUrl, safePublicFetch } = require('../electron/request-safety');

function mainBoundary() {
  const opened = [];
  const source = path.resolve(__dirname, '../electron/main.js');
  const realRequire = createRequire(source);
  const electron = {
    app: { setName() {}, getPath: () => '/tmp/unused-egress-fixture', requestSingleInstanceLock: () => false, quit() {} },
    shell: { openExternal: url => opened.push(url) },
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : realRequire(name), module: { exports: {} },
    __dirname: path.dirname(source), process: { argv: [], platform: process.platform }, Buffer, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8') + '\nmodule.exports = { guardPageRequests, sanitizeHtml, openExternal };', context, { filename: source });
  return { ...context.module.exports, opened };
}

const destructive = [
  '/index.php?m=task&f=delete&taskID=7', '/index.php?m=bug&f=DELETE&id=7',
  '/task-delete-7.html', '/bug-delete-7.html', '/task-deleteWorkhour-7.html', '/bug-batchDelete-7.html',
  '/index.php?m=task&f=view&f=delete&id=7', '/index.php?m=task&f=%64elete&id=7',
  '/index.php?m=task&f=%2564elete&id=7', '/index.php?m=task&amp;f=delete&amp;id=7',
  '/index.php?m=task&%20f=delete&id=7', '/index.php?m=task&+f=delete&id=7',
  '/index.php?m=task;f=delete;id=7', '/index.php?m=task;+f=delete;id=7',
  '/index.php?m=task&f[]=delete&id=7', '/index.php?_method=DELETE&id=7',
  '/task-%2564elete-7.html',
];

test('all external-entry checks deny known destructive routes and encoding variants, not normal read URLs', () => {
  const f = mainBoundary();
  for (const suffix of destructive) {
    const url = 'https://zentao.example.test' + suffix;
    assert.equal(safeExternalUrl(url), false, suffix);
    assert.equal(f.openExternal(url).ok, false, suffix);
  }
  for (const url of [
    'https://zentao.example.test/index.php?m=task&f=view&id=7',
    'https://zentao.example.test/bug-view-7.html',
    'https://zentao.example.test/index.php?m=file&f=read&fileID=7',
    'https://zentao.example.test/file-read-7.png',
    'https://zentao.example.test/image%20one.png',
    'https://zentao.example.test/index.php?q=How%20to%20delete',
    'https://zentao.example.test/api.php/v1/tasks?assignedTo=delete-user',
  ]) {
    assert.equal(safeExternalUrl(url), true, url);
    assert.equal(f.openExternal(url).ok, true, url);
  }
  assert.equal(f.opened.length, 7);
  for (const url of ['https://user:pass@example.test/', 'https://example.test\\task-delete-7.html', 'javascript:alert(1)']) {
    assert.equal(f.openExternal(url).ok, false);
  }
});

test('actual page guard with simulated Chromium callbacks allows only safe passive resources and redirect destinations', () => {
  const f = mainBoundary();
  let guard;
  f.guardPageRequests({ session: { webRequest: { onBeforeRequest(filter, callback) {
    assert.deepEqual(Array.from(filter.urls), ['http://*/*', 'https://*/*']);
    guard = callback;
  } } } });
  const blocked = (url, method = 'GET') => {
    let result;
    guard({ url, method }, value => { result = value.cancel; });
    return result;
  };
  for (const suffix of destructive) assert.equal(blocked('https://zentao.example.test' + suffix), true, suffix);
  for (const method of ['DELETE', 'POST', 'PUT', 'PATCH', 'get']) assert.equal(blocked('https://zentao.example.test/safe.png', method), true);
  assert.equal(blocked('https://zentao.example.test/image%20one.png'), false);
  assert.equal(blocked('https://zentao.example.test/safe.png', 'HEAD'), false);
  // Simulate the callback contract for a followed resource redirect. This is
  // logic coverage, not a claim that native Chromium interception was exercised.
  assert.equal(blocked('https://zentao.example.test/ordinary-image'), false);
  assert.equal(blocked('https://zentao.example.test/index.php?m=task&f=delete&id=7'), true);
});

test('real rich-text cleaner strips destructive quoted/unquoted attributes and alternate image sources', () => {
  const f = mainBoundary();
  const html = '<img src="/index.php?m=task&amp;f=delete&amp;id=7">' +
    '<img src=https://zentao.example.test/task-delete-7.html>' +
    '<a href="/index.php?m=task&%20f=delete&id=7">Unsafe</a>' +
    '<img src="/image%20one.png" srcset="https://zentao.example.test/bug-delete-7.html 2x">' +
    '<a href="/task-view-7.html">View</a>' +
    '<img src="data:image/png;base64,aGVsbG8=">';
  const result = f.sanitizeHtml(html, 'https://zentao.example.test');
  assert.doesNotMatch(result, /f=delete|task-delete|bug-delete|srcset/);
  assert.match(result, /image%20one\.png/);
  assert.match(result, /task-view-7\.html/);
  assert.match(result, /data:image\/png;base64,aGVsbG8=/);
});

test('public download redirect checks happen before the next network request and preserve benign downloads', async t => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/unsafe') res.writeHead(302, { Location: '/index.php?m=task&f=delete&id=7' });
    else if (req.url === '/safe') res.writeHead(302, { Location: '/archive%20one.zip' });
    else if (req.url === '/loop') res.writeHead(302, { Location: '/loop' });
    else res.writeHead(200);
    res.end('synthetic archive');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  await assert.rejects(safePublicFetch(base + '/unsafe'), /阻止/);
  assert.deepEqual(hits, ['/unsafe']);
  const response = await safePublicFetch(base + '/safe');
  assert.equal(await response.text(), 'synthetic archive');
  assert.deepEqual(hits, ['/unsafe', '/safe', '/archive%20one.zip']);
  await assert.rejects(safePublicFetch(base + '/loop'), /重定向/);
  assert.equal(hits.filter(url => url === '/loop').length, 6);
  assert.equal(hits.some(url => url.includes('f=delete')), false);
});
