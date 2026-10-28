'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ZentaoClient } = require('../electron/zentao');

async function fixture(t, { assignedTo = 'fixture-user', detailStatus = 200 } = {}) {
  const task = { id: 35, name: 'Task', status: 'wait', assignedTo, execution: 8, left: 2 };
  const writes = [], reads = [];
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api.php/v1/tokens') return json(res, 201, { token: 'fixture-token' });
    if (req.method === 'POST') {
      assert.equal(req.url, '/api.php/v1/tasks/35/start');
      let data = '';
      for await (const chunk of req) data += chunk;
      const body = JSON.parse(data);
      writes.push(body);
      // Reproduce the observed start action: omitted assignedTo clears the assignment.
      task.assignedTo = body.assignedTo || '';
      task.status = 'doing';
      Object.assign(task, { consumed: body.consumed, left: body.left, realStarted: body.realStarted });
      return json(res, 200, task);
    }
    reads.push(req.url);
    if (req.url === '/api.php/v1/tasks/35') return json(res, detailStatus,
      detailStatus === 200 ? { ...task, assignedTo: task.assignedTo ? { account: task.assignedTo } : null } : { error: 'denied' });
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

test('start rejects zero remaining hours without changing data instead of auto-completing on 22.6', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.startTask(35, { consumed: 0, left: 0 }), /剩余工时必须大于 0/);
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
