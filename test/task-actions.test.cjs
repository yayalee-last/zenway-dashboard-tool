'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ZentaoClient } = require('../electron/zentao');

async function fixture(t, { assignedTo = 'fixture-user', detailStatus = 200, action = 'start' } = {}) {
  const task = { id: 35, name: 'Task', status: ['close', 'assign'].includes(action) ? 'done' : 'wait', assignedTo, execution: 8, left: 2 };
  const writes = [], reads = [];
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api.php/v1/tokens') return json(res, 201, { token: 'fixture-token' });
    if (req.method === 'POST' || req.method === 'PUT') {
      assert.equal(req.method, action === 'assign' ? 'PUT' : 'POST');
      assert.equal(req.url, '/api.php/v1/tasks/35' + (action === 'assign' ? '' : '/' + action));
      let data = '';
      for await (const chunk of req) data += chunk;
      const body = JSON.parse(data);
      writes.push(body);
      if (action === 'assign') {
        // 22.6 api/v1/entries/task.php fills omitted edit fields from the old task.
        task.assignedTo = body.assignedTo;
      } else if (action === 'close') {
        // ZenTao 22.6 forwards comment only; absent/null leaves $_POST empty and skips close.
        if (Object.hasOwn(body, 'comment') && body.comment !== null) {
          task.status = 'closed';
          task.closedReason = 'done';
        }
      } else {
        // Reproduce the observed start action: omitted assignedTo clears the assignment.
        task.assignedTo = body.assignedTo || '';
        task.status = 'doing';
        Object.assign(task, { consumed: body.consumed, left: body.left, realStarted: body.realStarted });
      }
      return json(res, 200, task);
    }
    reads.push(req.url);
    if (req.url === '/api.php/v1/tasks/35') return json(res, detailStatus,
      detailStatus === 200 ? { ...task, assignedTo: task.assignedTo ? { account: task.assignedTo } : null } : { error: 'denied' });
    if (req.url.startsWith('/api.php/v1/users?')) {
      const page = Number(new URL(req.url, 'http://fixture.invalid').searchParams.get('page'));
      return json(res, 200, { total: 2, users: page === 1
        ? [{ account: 'fixture-user', realname: '我', email: 'private@example.invalid' }]
        : [{ account: 'other-user', realname: '其他人' }] });
    }
    if (req.url.startsWith('/api.php/v1/tasks?')) return json(res, 403, {});
    if (req.url.startsWith('/api.php/v1/executions?')) return json(res, 200, { executions: [{ id: 8, status: 'doing', project: 6 }] });
    if (req.url.startsWith('/api.php/v1/projects?')) return json(res, 200, { projects: [] });
    if (req.url.startsWith('/api.php/v1/executions/8/tasks?')) return json(res, 200,
      { tasks: task.assignedTo === 'fixture-user' ? [task] : [] });
    json(res, 404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const client = new ZentaoClient({ baseUrl: 'http://127.0.0.1:' + server.address().port,
    account: 'fixture-user', password: 'fixture-password' });
  return { client, task, writes, reads };
}

test('starting a task preserves its assignee and keeps it in open and all lists', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.fetchMyTasks()).items.length, 1);
  await f.client.startTask(35, { consumed: 0.5, left: 2, realStarted: '2026-10-27 10:22:00' });
  assert.equal(f.task.assignedTo, 'fixture-user');
  assert.deepEqual(f.writes, [{ assignedTo: 'fixture-user', consumed: 0.5, left: 2, realStarted: '2026-10-27 10:22:00' }]);
  const { items } = await f.client.fetchMyTasks();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'doing');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8').split('(async function init()')[0];
  const context = vm.createContext({ window: { ItemOrder: require('../renderer/item-order') } });
  vm.runInContext(source, context);
  context.items = items;
  for (const filter of ['open', 'all']) {
    assert.equal(vm.runInContext(`S.items = items; S.filter = '${filter}'; visibleItems().some(task => task.id === 35)`, context), true);
  }
});

test('start preserves the current assignee instead of replacing it with the operator', async t => {
  const f = await fixture(t, { assignedTo: 'other-user' });
  await f.client.startTask(35, { consumed: 1, left: 2 });
  assert.equal(f.task.assignedTo, 'other-user');
  assert.equal(f.writes[0].assignedTo, 'other-user');
});

test('start leaves an unassigned task unassigned', async t => {
  const f = await fixture(t, { assignedTo: '' });
  await f.client.startTask(35, { consumed: 1, left: 2 });
  assert.equal(f.task.assignedTo, '');
});

test('start does not write if current assignment cannot be read', async t => {
  const f = await fixture(t, { detailStatus: 403 });
  await assert.rejects(f.client.startTask(35, { consumed: 1, left: 2 }), error => error.status === 403);
  assert.equal(f.writes.length, 0);
  assert.equal(f.task.status, 'wait');
});

test('start retains its existing work-hour validation without changing data', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.startTask(35, { consumed: 0, left: 0 }), /不能同时填 0/);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
});

test('priority sorting places P1 before overdue lower priorities and keeps equal-priority deadlines ordered', () => {
  const { compareItems } = require('../renderer/item-order');
  const items = [
    { id: 1, pri: 3, deadline: '2000-01-01' },
    { id: 2, pri: 1, deadline: '2099-01-01' },
    { id: 3, pri: 1, deadline: '2099-02-01' },
    { id: 4, pri: 0 },
    { id: 5, pri: 2 },
  ];
  assert.deepEqual(items.sort((a, b) => compareItems(a, b, 'priority')).map(item => item.id), [2, 3, 5, 1, 4]);
});

test('completed sorting brings tasks awaiting closure and resolved bugs first without promoting closed or cancelled items', () => {
  const { compareItems } = require('../renderer/item-order');
  const items = [
    { id: 1, pri: 1, status: 'doing' },
    { id: 2, pri: 3, status: 'done' },
    { id: 3, pri: 4, status: 'resolved', kind: 'bug' },
    { id: 4, pri: 2, status: 'closed' },
    { id: 5, pri: 2, status: 'cancel' },
  ];
  assert.deepEqual(items.sort((a, b) => compareItems(a, b, 'completed')).map(item => item.id), [2, 3, 1, 4, 5]);
});

test('closing a completed task sends an explicit comment and actually closes it in ZenTao 22.6', async t => {
  const f = await fixture(t, { action: 'close' });
  const result = await f.client.closeTask(35);
  assert.equal(result.status, 'closed', 'HTTP 200 alone must not count as closing the task');
  assert.equal((await f.client.getTaskDetail(35)).status, 'closed');
  assert.deepEqual(f.writes, [{ closedReason: 'done', comment: '' }]);
});

test('assignment uses a minimal PUT and preserves completed status, work hours and title', async t => {
  const f = await fixture(t, { action: 'assign' });
  const before = { ...f.task };
  await f.client.assignTask(35, { assignedTo: 'other-user' });
  assert.deepEqual(f.writes, [{ assignedTo: 'other-user' }]);
  assert.deepEqual(f.task, { ...before, assignedTo: 'other-user' });
  assert.equal((await f.client.getTaskDetail(35)).assignedTo.account, 'other-user');
  assert.equal((await f.client.fetchMyTasks()).items.length, 0);
});

test('assignee list follows server pagination and exposes only account and realname', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.listUsers(), [
    { account: 'fixture-user', realname: '我' }, { account: 'other-user', realname: '其他人' },
  ]);
  assert.deepEqual(f.reads, ['/api.php/v1/users?limit=200&page=1', '/api.php/v1/users?limit=200&page=2']);
});

test('invalid assignment inputs are rejected before authentication or network', async () => {
  const client = new ZentaoClient({});
  client.ensureToken = () => assert.fail('invalid assignment must not authenticate');
  for (const payload of [{}, { assignedTo: '' }, { assignedTo: null }, { assignedTo: 'bad user' },
    { assignedTo: 'next', status: 'doing' }, { assignedTo: 'a'.repeat(101) }]) {
    await assert.rejects(client.assignTask(35, payload));
  }
  await assert.rejects(client.assignTask('../35', { assignedTo: 'next' }));
});
