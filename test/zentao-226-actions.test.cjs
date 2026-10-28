'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ZentaoClient } = require('../electron/zentao');
const { rendererFixture } = require('./fixtures/task-children.cjs');

// Self-contained localhost model of ZenTao 22.6 API behavior reviewed at
// easysoft/zentaopms commit d5bfff8c91cea48018275381e0a127ed6fa5c79f.
// The fixture implements a tiny field whitelist/transition model; no upstream
// source is copied here and tests never contact a real service.

const PASSWORD = 'fixture-password-do-not-echo';
const TOKEN = 'fixture-token-do-not-echo';
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = async req => {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
};

async function local226(t, { tasks = [], bugs = [] } = {}) {
  const taskRows = new Map(tasks.map(row => [row.id, { ...row }]));
  const bugRows = new Map(bugs.map(row => [row.id, { ...row }]));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    requests.push({ method: req.method, path: url.pathname, body });
    if (req.method === 'POST' && url.pathname === '/api.php/v1/tokens') return json(res, 201, { token: TOKEN });

    const taskDetail = /^\/api\.php\/v1\/tasks\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && taskDetail) {
      const row = taskRows.get(Number(taskDetail[1]));
      return row ? json(res, 200, { ...row }) : json(res, 404, { error: 'not found' });
    }
    const bugDetail = /^\/api\.php\/v1\/bugs\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && bugDetail) {
      const row = bugRows.get(Number(bugDetail[1]));
      return row ? json(res, 200, { ...row }) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && url.pathname === '/api.php/v1/tasks') {
      const list = [...taskRows.values()].filter(row => row.assignedTo === url.searchParams.get('assignedTo') && row.status !== 'closed' && !row.deleted);
      return json(res, 200, { tasks: list.map(row => ({ ...row })), total: list.length });
    }
    if (req.method === 'GET' && url.pathname === '/api.php/v1/executions') return json(res, 200, { executions: [] });
    if (req.method === 'GET' && url.pathname === '/api.php/v1/projects') return json(res, 200, { projects: [] });
    if (req.method === 'GET' && url.pathname === '/api.php/v1/products') return json(res, 200, { products: [{ id: 7, name: 'Fixture product' }] });
    if (req.method === 'GET' && url.pathname === '/api.php/v1/products/7/bugs') {
      const list = [...bugRows.values()].filter(row => row.assignedTo === 'alice' && row.status !== 'closed' && !row.deleted);
      return json(res, 200, { bugs: list.map(row => ({ ...row })), total: list.length });
    }

    const taskAction = /^\/api\.php\/v1\/tasks\/(\d+)\/(start|finish|close)$/.exec(url.pathname);
    const bugAction = /^\/api\.php\/v1\/bugs\/(\d+)\/close$/.exec(url.pathname);
    if (req.method === 'POST' && taskAction) {
      const row = taskRows.get(Number(taskAction[1]));
      if (!row) return json(res, 404, { error: 'not found' });
      const action = taskAction[2];
      const fields = action === 'start'
        ? ['assignedTo', 'consumed', 'left', 'realStarted', 'comment']
        : action === 'finish' ? ['currentConsumed', 'finishedDate', 'realStarted', 'comment'] : ['comment'];
      // batchSetPost copies its known field list and silently ignores extras.
      // A close with only ignored fields leaves the recognized POST empty.
      const recognized = Object.fromEntries(Object.entries(body).filter(([key]) => fields.includes(key)));
      if (action === 'close' && !Object.hasOwn(recognized, 'comment')) return json(res, 400, { error: { form: ['No recognized close fields'] } });
      if (action === 'start') {
        if (!Object.hasOwn(recognized, 'consumed') || !Object.hasOwn(recognized, 'left')) return json(res, 400, { error: { form: ['Missing start fields'] } });
        if (Number(recognized.consumed) < Number(row.consumed || 0)) {
          return json(res, 400, { error: {
            consumed: ['must not be below the current total'],
            password: PASSWORD,
            token: TOKEN,
            detail: '<b>private markup</b>',
            url: 'https://fixture.invalid/path?token=embedded-secret',
          } });
        }
        // In this 22.6 model, an unteamed start with left=0 completes and
        // transfers to openedBy. The client must reject before dispatching it.
        if (Number(recognized.left) === 0 && !row.team) {
          row.status = 'done';
          row.assignedTo = row.openedBy;
        } else {
          row.status = 'doing';
          if (Object.hasOwn(recognized, 'assignedTo')) row.assignedTo = recognized.assignedTo;
        }
        row.consumed = Number(recognized.consumed);
        row.left = Number(recognized.left);
        row.realStarted = recognized.realStarted;
      } else if (action === 'finish') {
        row.consumed = Number(row.consumed || 0) + Number(recognized.currentConsumed || 0);
        row.realStarted = recognized.realStarted || row.realStarted;
        row.finishedDate = recognized.finishedDate;
        row.left = 0;
        row.status = 'done';
      } else {
        row.status = 'closed';
        row.assignedTo = 'closed';
        row.deleted = false;
      }
      return json(res, 200, { ...row });
    }
    if (req.method === 'POST' && bugAction) {
      const row = bugRows.get(Number(bugAction[1]));
      if (!row) return json(res, 404, { error: 'not found' });
      const recognized = Object.fromEntries(Object.entries(body).filter(([key]) => key === 'comment'));
      if (!Object.hasOwn(recognized, 'comment')) return json(res, 400, { error: { form: ['No recognized close fields'] } });
      row.status = 'closed';
      row.assignedTo = 'closed';
      row.deleted = false;
      return json(res, 200, { ...row });
    }
    return json(res, 404, { error: 'not found' });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new ZentaoClient({ baseUrl, account: 'alice', password: PASSWORD, timeoutMs: 5000 });
  return { client, requests, tasks: taskRows, bugs: bugRows, baseUrl };
}

const actionRequests = (fixture, path) => fixture.requests.filter(request => request.method === 'POST' && request.path === path);

test('start with zero remaining is rejected before action POST even with positive consumed hours', async t => {
  const f = await local226(t, { tasks: [{ id: 1, status: 'wait', assignedTo: 'alice', openedBy: 'creator', consumed: 1, left: 3, deleted: false }] });
  await assert.rejects(f.client.startTask(1, { consumed: 2, left: 0 }), /剩余工时必须大于 0/);
  assert.equal(f.requests.length, 0, 'validation happens before even token or detail requests');
  assert.equal(actionRequests(f, '/api.php/v1/tasks/1/start').length, 0);
  assert.equal(f.tasks.get(1).status, 'wait');
  assert.equal(f.tasks.get(1).assignedTo, 'alice');
});

test('fresh detail prevents lowering cumulative consumed; ordinary start preserves current assignee', async t => {
  const f = await local226(t, { tasks: [{ id: 1, status: 'wait', assignedTo: 'alice', openedBy: 'creator', consumed: 5, left: 3, deleted: false }] });
  await assert.rejects(f.client.startTask(1, { consumed: 4, left: 2 }), /不能少于服务器当前消耗/);
  assert.equal(actionRequests(f, '/api.php/v1/tasks/1/start').length, 0);

  await f.client.startTask(1, { consumed: 6, left: 2, realStarted: '2026-10-20 08:00:00' });
  const writes = actionRequests(f, '/api.php/v1/tasks/1/start');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { assignedTo: 'alice', consumed: 6, left: 2, realStarted: '2026-10-20 08:00:00' });
  assert.equal(f.tasks.get(1).status, 'doing');
  assert.equal(f.tasks.get(1).assignedTo, 'alice');
});

test('finish sends incremental hours and explicit historical dates; server retains task and UI keeps done item in All only', async t => {
  const f = await local226(t, { tasks: [{
    id: 1, name: 'Finished fixture', status: 'doing', assignedTo: 'alice', openedBy: 'creator',
    consumed: 2, left: 1, realStarted: '2026-10-20 08:00:00', deleted: false,
  }] });
  await f.client.finishTask(1, { currentConsumed: 1.5, left: 0, finishedDate: '2026-10-21 12:30:00' });
  const writes = actionRequests(f, '/api.php/v1/tasks/1/finish');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, {
    realStarted: '2026-10-20 08:00:00', finishedDate: '2026-10-21 12:30:00', currentConsumed: 1.5,
  });
  assert.equal(Object.hasOwn(writes[0].body, 'consumed'), false);
  assert.equal(Object.hasOwn(writes[0].body, 'left'), false);
  assert.equal(f.tasks.get(1).consumed, 3.5, 'fixture server adds currentConsumed to its prior cumulative total');
  assert.equal(f.tasks.get(1).realStarted, '2026-10-20 08:00:00');
  assert.equal(f.tasks.get(1).finishedDate, '2026-10-21 12:30:00', 'historical date is not silently replaced with now');
  assert.equal(f.tasks.get(1).status, 'done');

  const stillExists = await f.client.getTaskDetail(1);
  assert.equal(stillExists.deleted, false);
  const ui = rendererFixture();
  ui.S.cfg = { sortMode: 'priority' };
  ui.S.items = [f.client._normalize(stillExists), f.client._normalize({ id: 2, name: 'Open fixture', status: 'wait' })];
  ui.S.filter = 'open';
  assert.deepEqual(ui.visibleItems().map(item => item.id), [2]);
  ui.S.filter = 'all';
  assert.deepEqual(ui.visibleItems().map(item => item.id).sort((a, b) => a - b), [1, 2]);
});

test('task and bug close submit comment-only form; closed assignee can leave lists without deletion', async t => {
  const f = await local226(t, {
    tasks: [{ id: 1, name: 'Done fixture', status: 'done', assignedTo: 'alice', openedBy: 'creator', consumed: 2, left: 0, deleted: false }],
    bugs: [{ id: 5, title: 'Resolved fixture', status: 'resolved', assignedTo: 'alice', deleted: false }],
  });
  assert.equal((await f.client.fetchMyTasks()).items.some(item => item.id === 1), true);
  assert.equal((await f.client.fetchMyBugs()).items.some(item => item.id === 5), true);

  for (const [path, record] of [
    ['/api.php/v1/tasks/1/close', f.tasks.get(1)],
    ['/api.php/v1/bugs/5/close', f.bugs.get(5)],
  ]) {
    for (const invalidBody of [{}, { closedReason: 'done' }]) {
      const response = await f.client._raw('POST', path, { json: invalidBody });
      assert.equal(response.status, 400);
      assert.equal(record.status, path.includes('/tasks/') ? 'done' : 'resolved');
    }
  }

  await f.client.closeTask(1);
  await f.client.closeBug(5);
  assert.deepEqual(actionRequests(f, '/api.php/v1/tasks/1/close').map(request => request.body).filter(body => Object.hasOwn(body, 'comment')), [{ comment: '' }]);
  assert.deepEqual(actionRequests(f, '/api.php/v1/bugs/5/close').map(request => request.body).filter(body => Object.hasOwn(body, 'comment')), [{ comment: '' }]);
  for (const record of [f.tasks.get(1), f.bugs.get(5)]) {
    assert.equal(record.status, 'closed');
    assert.equal(record.assignedTo, 'closed');
    assert.equal(record.deleted, false, 'closed/closed assignee does not imply deletion');
  }
  assert.ok(await f.client.getTaskDetail(1), 'closed task remains directly readable');
  assert.ok(await f.client.getBugDetail(5), 'closed bug remains directly readable');
  assert.equal((await f.client.fetchMyTasks()).items.some(item => item.id === 1), false);
  assert.equal((await f.client.fetchMyBugs()).items.some(item => item.id === 5), false);
});

test('synthetic batchSetPost probe ignores unknown fields but requires a recognized close comment', async t => {
  const f = await local226(t, {
    tasks: [{ id: 1, status: 'doing', assignedTo: 'alice', openedBy: 'creator', consumed: 2, left: 1, realStarted: '2026-10-20 08:00:00', deleted: false }],
    bugs: [{ id: 5, status: 'resolved', assignedTo: 'alice', deleted: false }],
  });

  const finish = await f.client._raw('POST', '/api.php/v1/tasks/1/finish', { json: {
    currentConsumed: 1, consumed: 999, left: 8, realStarted: '2026-10-20 08:00:00',
    finishedDate: '2026-10-21 12:30:00', ignoredField: 'ignored',
  } });
  assert.equal(finish.status, 200);
  assert.equal(f.tasks.get(1).consumed, 3, 'only recognized currentConsumed is added to the prior total');
  assert.equal(f.tasks.get(1).left, 0, 'server forces zero remaining on finish');
  assert.equal(f.tasks.get(1).status, 'done');
  assert.equal(f.tasks.get(1).realStarted, '2026-10-20 08:00:00');
  assert.equal(f.tasks.get(1).finishedDate, '2026-10-21 12:30:00');

  for (const [url, row] of [
    ['/api.php/v1/tasks/1/close', f.tasks.get(1)],
    ['/api.php/v1/bugs/5/close', f.bugs.get(5)],
  ]) {
    const response = await f.client._raw('POST', url, { json: { comment: '', closedReason: 'done', ignoredField: 'ignored' } });
    assert.equal(response.status, 200, 'extra fields are ignored when a recognized comment is present');
    assert.equal(row.status, 'closed');
    assert.equal(row.assignedTo, 'closed');
    assert.equal(row.deleted, false);
  }
});

test('structured HTTP 400 field errors are readable, bounded and redacted', async t => {
  const f = await local226(t, { tasks: [{ id: 1, status: 'wait', assignedTo: 'alice', consumed: 5, left: 2, deleted: false }] });
  await assert.rejects(
    f.client.postJSON('/tasks/1/start', { assignedTo: 'alice', consumed: 4, left: 2, realStarted: '2026-10-20 08:00:00' }),
    error => {
      assert.equal(error.status, 400);
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /consumed.*must not be below the current total/);
      assert.ok(error.message.length <= 600);
      assert.doesNotMatch(error.message, /password|token|fixture.invalid|embedded-secret|<b>|https?:\/\//i);
      assert.equal(error.body, undefined, 'raw structured response is not exposed on client errors');
      return true;
    },
  );
});
