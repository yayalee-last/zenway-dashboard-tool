'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const safety = require('../electron/request-safety');
const { ZentaoClient, ZentaoError } = require('../electron/zentao');

function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

function client() {
  return new ZentaoClient({ baseUrl: 'https://zentao.example.test/zt', account: 'alice', password: 'not-a-real-password' });
}

test('request safety primitives admit only explicit REST operation shapes', () => {
  assert.doesNotThrow(() => safety.assertRestOperation('GET', '/api.php/v1/tasks'));
  assert.doesNotThrow(() => safety.assertRestOperation('GET', '/api.php/v1/tasks/17'));
  assert.doesNotThrow(() => safety.assertRestOperation('POST', '/api.php/v1/tokens'));
  assert.doesNotThrow(() => safety.assertRestOperation('POST', '/api.php/v1/tasks/17/start'));
  assert.doesNotThrow(() => safety.assertRestOperation('POST', '/api.php/v1/bugs/21/resolve'));

  for (const [method, path] of [
    ['DELETE', '/api.php/v1/tasks/17'],
    ['GET', 'https://attacker.invalid/api.php/v1/tasks'],
    ['GET', '//attacker.invalid/api.php/v1/tasks'],
    ['GET', '/index.php?m=task&f=delete&id=17'],
    ['GET', '/api.php/v1/tasks?x=1'],
    ['POST', '/api.php/v1/tasks/17?x=1'],
    ['GET', '/api.php/v1/../tokens'],
    ['GET', '/api.php/v1/%2e%2e/tokens'],
    ['GET', '/api.php/v1/tasks/%2f..%2f17'],
    ['GET', '/api.php/v1/tasks/17/close'],
    ['POST', '/api.php/v1/tasks/17/delete'],
    ['POST', '/api.php/v1/files/17'],
  ]) {
    assert.throws(() => safety.assertRestOperation(method, path), `${method} ${path} should be rejected`);
  }
});

test('positiveId rejects malformed values', () => {
  for (const value of [1, 17, '1', '0009']) assert.equal(safety.positiveId(value), Number(value));
  for (const value of [0, -1, 1.2, NaN, Infinity, '', ' 1', '1x', '1/2', '%31', null, {}, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => safety.positiveId(value));
});

test('_raw rejects unsafe verbs, legacy routes, absolute URLs and traversal before network', async () => {
  await withFetch(async () => { throw new Error('fetch must not run'); }, async () => {
    const c = client();
    for (const [method, path] of [
      ['DELETE', '/api.php/v1/tasks/1'],
      ['GET', '/index.php?m=task&f=view&id=1'],
      ['GET', 'https://evil.invalid/api.php/v1/tasks'],
      ['GET', '/api.php/v1/tasks/1/../2'],
      ['GET', '/api.php/v1/tasks/%2e%2e/tokens'],
      ['GET', '/api.php/v1/tasks/1?include=all'],
    ['GET', '/api.php/v1/%252e%252e/tokens'],
    ['GET', '/api.php/v1\\tasks\\1'],
    ['GET', '/api.php/v1/tasks/1%2fclose'],
    ['GET', '/api.php/v1/tasks/1%252fclose'],
    ]) {
      await assert.rejects(c._raw(method, path), ZentaoError, `${method} ${path}`);
    }
  });
});

test('malformed object ids fail before authentication or any request', async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  await withFetch(async () => { fetchCalls++; throw new Error('unexpected network'); }, async () => {
    const c = client();
    c.ensureToken = async () => { authCalls++; return 'test-token'; };
    const bad = ['0', -4, 1.5, '7abc', '1/resolve', '%2f', null];
    const methods = [
      id => c.getTaskDetail(id), id => c.getBugDetail(id),
      id => c.resolveBug(id), id => c.closeBug(id),
      id => c.startTask(id, { consumed: 1 }), id => c.finishTask(id), id => c.closeTask(id),
      id => c.fetchFileDataUrl(id), id => c.downloadFile(id, '/tmp/unused-test-destination'),
    ];
    for (const id of bad) {
      for (const invoke of methods) await assert.rejects(invoke(id), ZentaoError, `id=${String(id)}`);
    }
  });
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('ordinary collection, detail, token and action routes remain usable', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push([new URL(url).pathname, init.method]);
    if (new URL(url).pathname.endsWith('/tokens')) {
      return new Response(JSON.stringify({ token: 'fixture-token' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {
    const c = client();
    assert.equal((await c.getJSON('/tasks')).ok, true);
    assert.equal((await c.getTaskDetail(17)).ok, true);
    assert.equal((await c.postJSON('/tasks/17/start', { consumed: 1 })).ok, true);
  });
  assert.deepEqual(calls.map(c => c[1]), ['POST', 'GET', 'GET', 'POST']);
  assert.ok(calls.every(([path]) => path.startsWith('/zt/api.php/v1/')));
});

test('22.6 close actions include the recognized empty comment field', async () => {
  const writes = [];
  await withFetch(async (url, init) => {
    if (new URL(url).pathname.endsWith('/tokens')) {
      return new Response(JSON.stringify({ token: 'fixture-token' }), { status: 201 });
    }
    writes.push([new URL(url).pathname, JSON.parse(init.body)]);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async () => {
    const c = client();
    await c.closeTask(17);
    await c.closeBug(21);
  });
  assert.deepEqual(writes, [
    ['/zt/api.php/v1/tasks/17/close', { closedReason: 'done', comment: '' }],
    ['/zt/api.php/v1/bugs/21/close', { comment: '' }],
  ]);
});

test('token-bearing requests disallow redirects, including file and image requests', async () => {
  const opts = [];
  let directRawCalls = 0;
  await withFetch(async (_url, init) => {
    directRawCalls++;
    opts.push(init);
    return new Response('denied', { status: 302, headers: { location: 'https://attacker.invalid/collect' } });
  }, async () => {
    const c = client();
    await assert.rejects(c._raw('GET', '/api.php/v1/tasks'), ZentaoError);
  });
  assert.equal(directRawCalls, 1, 'no follow-up request may be made to the redirect target');
  assert.equal(opts.at(-1).redirect, 'error');

  for (const operation of ['image', 'download']) {
    const seen = [];
    await withFetch(async (_url, init) => {
      seen.push(init);
      return new Response('not a file', { status: 302, headers: { location: 'https://attacker.invalid/collect' } });
    }, async () => {
      const c = client();
      c.token = 'fixture-token';
      c.tokenExpireAt = Date.now() + 60000;
      if (operation === 'image') await c.fetchFileDataUrl(17);
      else await assert.rejects(c.downloadFile(17, '/tmp/unused-test-destination'));
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].redirect, 'error', `${operation} request must disable redirect following`);
  }
});

test('local redirect fixture proves no token-bearing request reaches its target', async () => {
  let targetHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect-target') {
      targetHits++;
      res.writeHead(200, { 'content-type': 'text/plain' }).end('should not be fetched');
      return;
    }
    res.writeHead(302, { location: '/redirect-target' }).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const c = client();
    c.applyConfig({ baseUrl: `http://127.0.0.1:${port}`, account: 'alice', password: 'not-a-real-password' });
    c.token = 'synthetic-token-must-not-escape';
    c.tokenExpireAt = Date.now() + 60000;
    await assert.rejects(c._raw('GET', '/api.php/v1/tasks'), ZentaoError);
    await assert.rejects(c.fetchFileDataUrl(17));
    await assert.rejects(c.downloadFile(17, '/tmp/unused-test-destination'), ZentaoError);
    assert.equal(targetHits, 0, 'redirect destination must never receive a follow-up request');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('file image reads reauthenticate at most once on a single 401', async () => {
  let authCalls = [];
  let requests = [];
  await withFetch(async (_url, init) => {
    requests.push(init.headers.Token);
    if (requests.length === 1) return new Response('unauthorized', { status: 401 });
    return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), { status: 200 });
  }, async () => {
    const c = client();
    c.ensureToken = async force => {
      authCalls.push(Boolean(force));
      c.token = force ? 'new-synthetic-token' : 'old-synthetic-token';
      return c.token;
    };
    const result = await c.fetchFileDataUrl(17);
    assert.match(result, /^data:image\/png;base64,/);
  });
  assert.deepEqual(authCalls, [false, true]);
  assert.deepEqual(requests, ['old-synthetic-token', 'new-synthetic-token']);
});

test('uncertain write outcomes are never retried automatically', async () => {
  for (const failure of [
    async () => new Response('unauthorized', { status: 401 }),
    async () => new Response('<html><title>Login</title></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => { throw new TypeError('network connection reset'); },
  ]) {
    let fetchCalls = 0;
    let authCalls = 0;
    await withFetch(async () => {
      fetchCalls++;
      return failure();
    }, async () => {
      const c = client();
      c.ensureToken = async () => { authCalls++; return 'fixture-token'; };
      await assert.rejects(c.postJSON('/tasks/17/close', { closedReason: 'done' }));
    });
    assert.equal(fetchCalls, 1, 'only the write request should be attempted');
    assert.equal(authCalls, 1, 'authentication should not be forced again after an uncertain write');
  }
});

test('server errors are bounded and do not echo credentials, tokens or HTML', async () => {
  const secret = 'fixture-secret-token-abc';
  const huge = `password=not-a-real-password Token: ${secret} ${'<b>'.repeat(4000)}server detail`;
  await withFetch(async () => new Response(JSON.stringify({ error: huge }), { status: 500 }), async () => {
    const c = client();
    c.token = secret;
    c.ensureToken = async () => 'fixture-token';
    await assert.rejects(c.postJSON('/tasks/17/close'), err => {
      assert.ok(err instanceof ZentaoError);
      assert.ok(err.message.length <= 600, `message length was ${err.message.length}`);
      assert.doesNotMatch(err.message, /fixture-secret-token-abc|not-a-real-password|password\s*=|<b>/i);
      const exposedError = JSON.stringify({ message: err.message, status: err.status, body: err.body });
      assert.ok(exposedError.length <= 1200, `exposed error length was ${exposedError.length}`);
      assert.doesNotMatch(exposedError, /fixture-secret-token-abc|not-a-real-password|password\s*=|<b>/i);
      return true;
    });
  });
});

test('main work-hour fields and request payloads remain unchanged', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push([new URL(url).pathname, init.method, init.body && JSON.parse(init.body)]);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async () => {
    const c = client();
    c.ensureToken = async () => 'fixture-token';
    c.getTaskDetail = async () => ({ id: 17, assignedTo: 'alice', consumed: 5 });
    await c.startTask(17, { consumed: 0.5, left: 0, realStarted: '2026-10-28 10:00:00' });
    await c.finishTask(17, { currentConsumed: 2, left: 0, realStarted: '2026-10-28 10:00:00', finishedDate: '2026-10-28 11:00:00' });
  });
  assert.deepEqual(calls, [
    ['/zt/api.php/v1/tasks/17/start', 'POST', { assignedTo: 'alice', consumed: 0.5, left: 0, realStarted: '2026-10-28 10:00:00' }],
    ['/zt/api.php/v1/tasks/17/finish', 'POST', { realStarted: '2026-10-28 10:00:00', finishedDate: '2026-10-28 11:00:00', consumed: 2, currentConsumed: 2, left: 0 }],
  ]);
});
