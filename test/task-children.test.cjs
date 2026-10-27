'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mainFixture, rendererFixture } = require('./fixtures/task-children.cjs');
const { ZentaoClient } = require('../electron/zentao');

const parent = extra => ({ id: 10, name: 'Parent', status: 'doing', assignedTo: 'Me', parent: -1, ...extra });
const child = (id, status, assignedTo, extra = {}) => ({ id, name: 'Child ' + id, status, assignedTo, left: 0, ...extra });
const plain = value => JSON.parse(JSON.stringify(value));
const detail = async (f, id = 10) => {
  const result = await f.invoke('task:detail', id);
  assert.equal(result.ok, true, result.error);
  return result.task;
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('real detail handler preserves all readable statuses and normalizes string/object ownership', async () => {
  const f = mainFixture([parent({ children: [
    child(11, 'wait', 'mE', { assignedToRealName: 'Mine' }),
    child(12, 'doing', { account: 'other', realname: 'Other' }),
    child(13, 'done', { account: 'ME', realname: 'Mine object' }),
    child(14, 'closed', null), child(15, 'cancel', 'other'), child(16, 'pause', { realname: 'Unknown account' }),
  ] })]);
  const task = await detail(f);
  assert.equal(task.childrenState, 'supplied');
  assert.equal(task.childrenTotal, 6);
  assert.deepEqual(plain(task.children.map(c => c.status)), ['wait', 'doing', 'done', 'closed', 'cancel', 'pause']);
  assert.deepEqual(plain(task.children.map(c => c.isMine)), [true, false, true, false, false, false]);
  assert.equal(task.children[1].account, 'other');
  assert.equal(task.children[1].realname, 'Other');
  assert.equal(task.children[5].readOnly, true);
  assert.equal(task.children[5].realname, 'Unknown account');
  assert.equal(task.readOnly, false);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.reads, [10], 'no child detail fan-out');
});

test('ID-map children preserve numeric map keys for entries without id', async () => {
  const f = mainFixture([parent({ children: { 21: { name: 'Key child', status: 'done', assignedTo: { account: 'ME' } }, 22: child(22, 'doing', 'other') } })]);
  const task = await detail(f);
  assert.equal(task.childrenState, 'supplied');
  assert.deepEqual(plain(task.children.map(c => c.id)), [21, 22]);
  assert.equal(task.children[0].isMine, true);
});

for (const [label, children, expected, count] of [
  ['missing', undefined, 'unavailable', null], ['null', null, 'unavailable', null],
  ['string', 'not supplied', 'unavailable', null], ['empty array', [], 'supplied', 0],
  ['empty map', {}, 'supplied', 0], ['error map', { error: 'forbidden' }, 'partial', null],
  ['mixed invalid rows', [null, child(30, 'done', 'other'), { name: 'No id' }], 'partial', null],
]) {
  test('detail distinguishes ' + label + ' children from confirmed zero', async () => {
    const task = await detail(mainFixture([parent({ children })]));
    assert.equal(task.childrenState, expected);
    assert.equal(task.childrenTotal, count);
    const ui = rendererFixture();
    ui.renderDetail(task);
    if (expected === 'unavailable') assert.match(ui.node('dt-body').textContent, /未返回子任务数据.*无法确认/);
    else if (expected === 'partial') assert.match(ui.node('dt-body').textContent, /部分子任务数据无法识别/);
    else assert.match(ui.node('dt-body').textContent, /本次接口返回 0 条/);
    if (expected !== 'supplied') assert.doesNotMatch(ui.node('dt-body').textContent, /0 条子任务/);
  });
}

test('invalid detail ids and unreadable/mismatched responses fail without fallback scanning', async () => {
  const f = mainFixture([parent()]);
  for (const id of ['../tasks', '10', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal((await f.invoke('task:detail', id)).ok, false);
  }
  assert.deepEqual(f.reads, []);
  f.tasks.set(10, new Error('fixture denied'));
  assert.match((await f.invoke('task:detail', 10)).error, /fixture denied/);
  f.tasks.set(10, { id: 11 });
  assert.equal((await f.invoke('task:detail', 10)).ok, false);
  assert.deepEqual(f.reads, [10, 10]);
});

test('new reference data never changes homepage membership, task counts, or preview source', async () => {
  const f = mainFixture([parent({ children: [child(11, 'doing', 'other'), child(12, 'done', 'other')] })]);
  f.home.push({ id: 10, kind: 'task', name: 'Parent', status: 'doing', pri: 2 });
  await f.invoke('zentao:refresh');
  const before = plain(f.state());
  await detail(f);
  assert.deepEqual(plain(f.state()), before);
  assert.equal(f.state().taskCount, 1);
  const ui = rendererFixture(id => f.invoke('task:detail', id));
  ui.S.items = f.state().items;
  ui.S.st = f.state();
  ui.renderStatus();
  const row = ui.row(f.home[0]);
  await ui.toggleTree(row, f.home[0], row.querySelectorAll('.expander')[0]);
  ui.renderStatus();
  assert.equal(ui.node('count').textContent, '1');
  assert.deepEqual(plain(ui.S.items.map(item => item.id)), [10]);
  assert.equal(ui.visibleItems().length, 1);
  assert.deepEqual(plain(f.state().items.map(item => item.id)), [10]);
});

test('list normalization recognizes known parent markers without requesting any details', () => {
  const client = new ZentaoClient({ baseUrl: 'https://zentao.invalid', account: 'Me' });
  client.getJSON = async () => assert.fail('no network or eager detail requests');
  const ui = rendererFixture(() => assert.fail('render must not request details'));
  for (const raw of [parent({ isParent: 1, parent: 0 }), parent({ isParent: undefined }), parent({ parent: 0, children: [child(11, 'wait', 'other')] }), parent({ parent: 0, children: undefined })]) {
    const normalized = client._normalize(raw);
    assert.equal(ui.row(normalized).querySelectorAll('.expander').length, 1);
  }
  const leaf = client._normalize(parent({ isParent: 0, parent: 0, children: [] }));
  assert.equal(ui.row(leaf).querySelectorAll('.expander').length, 0);
});

for (const ownership of ['other', '', null, { realname: 'Unknown' }, { account: 'other' }]) {
  test('task action rejects reference/uncertain ownership even with forged frontend flags: ' + JSON.stringify(ownership), async () => {
    const f = mainFixture([parent({ assignedTo: ownership })]);
    for (const action of ['start', 'finish', 'close']) {
      const result = await f.invoke('task:action', { id: 10, action, isMine: true, readOnly: false });
      assert.equal(result.ok, false);
      assert.match(result.error, /明确指派给自己/);
    }
    assert.equal(f.writes.length, 0);
  });
}

test('current self owner retains start/finish/close and normal refresh', async () => {
  const f = mainFixture([parent({ assignedTo: { account: 'mE' } })]);
  for (const action of ['start', 'finish', 'close']) {
    const result = await f.invoke('task:action', { id: 10, action, payload: { consumed: 1, left: 2, closedReason: 'done' } });
    assert.equal(result.ok, true, result.error);
  }
  assert.deepEqual(f.writes.map(write => write.method), ['startTask', 'finishTask', 'closeTask']);
  assert.equal(f.reads.length, 6, 'fresh owner check and existing post-write read for each action');
});

test('action fails closed on assignment changed since display, read failure, or wrong returned id', async () => {
  const f = mainFixture([parent()]);
  assert.equal((await detail(f)).isMine, true);
  f.tasks.get(10).assignedTo = 'other';
  assert.equal((await f.invoke('task:action', { id: 10, action: 'finish' })).ok, false);
  f.tasks.set(10, new Error('no permission'));
  assert.equal((await f.invoke('task:action', { id: 10, action: 'finish' })).ok, false);
  f.tasks.set(10, parent({ id: 99 }));
  assert.equal((await f.invoke('task:action', { id: 10, action: 'finish' })).ok, false);
  assert.equal(f.writes.length, 0);
});

test('action rejects invalid ids/actions, unrelated senders and subframes before reads/writes', async () => {
  const f = mainFixture([parent()]);
  for (const id of ['10', '../10', 0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal((await f.invoke('task:action', { id, action: 'start' })).ok, false);
  }
  for (const action of ['delete', '', null]) assert.equal((await f.invoke('task:action', { id: 10, action })).ok, false);
  for (const sender of [null, {}, { ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) {
    assert.equal((await f.invoke('task:action', { id: 10, action: 'finish' }, sender)).ok, false);
  }
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
});

test('actual renderer detail shows owner/status/hours of all kids and only confirmed self gets write buttons', async () => {
  const f = mainFixture([parent({ children: [child(11, 'done', { account: 'other', realname: 'Other person' }), child(12, 'wait', 'Me')] }), child(11, 'done', 'other')]);
  const ui = rendererFixture(id => f.invoke('task:detail', id));
  const task = await detail(f);
  ui.renderDetail(task);
  const body = ui.node('dt-body');
  assert.equal(body.querySelectorAll('.task-child').length, 2);
  assert.match(body.textContent, /参考 · Other person · 已完成 · 剩0h/);
  assert.match(body.textContent, /我 · Me · 未开始/);
  assert.equal(ui.node('dt-foot').querySelectorAll('.primary').length, 1);
  await body.querySelectorAll('.task-child')[0].click();
  // The actual click callback starts openDetail without returning its promise.
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.DT.id, 11);
  assert.equal(ui.node('dt-foot').querySelectorAll('.primary').length, 0);
  assert.match(body.textContent, /参考 · 只读/);
  assert.equal(ui.node('dt-foot').children.length, 1, 'browser remains available');
  ui.openTaskAction('close', { id: 11, name: 'Other', readOnly: true, isMine: false });
  assert.equal(ui.pending(), null);
  for (const status of ['wait', 'doing', 'done']) {
    ui.renderDetail({ ...task, status, isMine: true, readOnly: false });
    assert.equal(ui.node('dt-foot').querySelectorAll('.primary').length, 1);
    ui.renderDetail({ ...task, status, isMine: false, readOnly: true });
    assert.equal(ui.node('dt-foot').querySelectorAll('.primary').length, 0);
  }
});

test('expanded tree shows reference children and browser/parent navigation, repeats collapse/reopen safely', async () => {
  const f = mainFixture([parent({ children: [child(11, 'doing', 'Me'), child(12, 'done', 'other')] })]);
  const ui = rendererFixture(id => f.invoke('task:detail', id));
  const item = { id: 11, name: 'Mine', status: 'doing', parent: 10 };
  const row = ui.row(item), button = row.querySelectorAll('.expander')[0];
  await ui.toggleTree(row, item, button);
  assert.equal(row.nextElementSibling.className, 'subs');
  assert.match(row.nextElementSibling.textContent, /参考 · other · 已完成/);
  assert.doesNotMatch(row.nextElementSibling.textContent, /Child 11/);
  await row.nextElementSibling.children[0].click();
  await row.nextElementSibling.children[1].click();
  assert.match(ui.opened[0], /id=10/);
  assert.match(ui.opened[1], /task-view-12/);
  await ui.toggleTree(row, item, button);
  assert.equal(row.nextElementSibling, undefined);
  await ui.toggleTree(row, item, button);
  assert.equal(row.nextElementSibling.className, 'subs');
  assert.deepEqual(f.reads, [10, 10]);
});

test('tree distinguishes unknown/error/empty and resets disabled state for retry', async () => {
  let response = { ok: false, error: 'fixture denied' };
  const ui = rendererFixture(async () => response);
  const item = { id: 10, name: 'Unmarked parent', status: 'doing', parent: 0 };
  const row = ui.row(item), button = row.querySelectorAll('.expander')[0];
  await ui.toggleTree(row, item, button);
  assert.equal(button.disabled, false);
  assert.equal(row.nextElementSibling, undefined);
  response = { ok: true, task: { ...item, childrenState: 'unavailable', children: [] } };
  await ui.toggleTree(row, item, button);
  assert.match(row.nextElementSibling.textContent, /无法确认是否为空/);
  await ui.toggleTree(row, item, button);
  response = { ok: true, task: { ...item, childrenState: 'supplied', children: [] } };
  await ui.toggleTree(row, item, button);
  assert.match(row.nextElementSibling.textContent, /本次接口返回 0 条/);
});

test('inflight tree ignores duplicate requests and does not attach after list refresh', async () => {
  const pending = deferred(); let requests = 0;
  const ui = rendererFixture(() => { requests++; return pending.promise; });
  const item = { id: 10, name: 'Parent', parent: -1, status: 'doing' };
  const row = ui.row(item), button = row.querySelectorAll('.expander')[0];
  const first = ui.toggleTree(row, item, button);
  await ui.toggleTree(row, item, button);
  assert.equal(requests, 1);
  row.remove();
  pending.resolve({ ok: true, task: { ...item, childrenState: 'supplied', children: [] } });
  await first;
  assert.equal(button.disabled, false);
  assert.equal(ui.node('list').children.length, 0);
});

test('detail navigation replaces old actions with parent permissions, supports close-return and failed-read retry', async () => {
  const f = mainFixture([parent({ assignedTo: 'other', children: [] }), child(11, 'wait', 'Me', { parent: 10 })]);
  const ui = rendererFixture(id => f.invoke('task:detail', id));
  await ui.openDetail({ id: 11 });
  assert.equal(ui.node('dt-foot').querySelectorAll('.primary').length, 1);
  const up = ui.node('dt-body').querySelectorAll('.dt-sub')[0];
  assert.match(up.textContent, /#10/);
  await up.click(); await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.DT.id, 10);
  assert.equal(ui.node('dt-foot').querySelectorAll('.primary').length, 0);
  ui.closeDetail();
  assert.equal(ui.DT.open, false);
  assert.equal(ui.node('detail').hidden, true);
  assert.equal(ui.node('list').hidden, false);
  f.tasks.set(11, new Error('fixture denied'));
  await ui.openDetail({ id: 11 });
  assert.match(ui.node('dt-body').textContent, /fixture denied/);
  assert.equal(ui.node('dt-foot').hidden, true);
  f.tasks.set(11, child(11, 'wait', 'Me'));
  await ui.openDetail({ id: 11 });
  assert.equal(ui.node('dt-foot').querySelectorAll('.primary').length, 1);
});

test('same-id detail requests, newer navigation, and close do not resurrect stale response/actions', async () => {
  const requests = [];
  const ui = rendererFixture(() => { const pending = deferred(); requests.push(pending); return pending.promise; });
  const first = ui.openDetail({ id: 10 });
  const second = ui.openDetail({ id: 10 });
  requests[1].resolve({ ok: true, task: { id: 10, name: 'New reference', status: 'doing', isMine: false, readOnly: true, children: [], childrenState: 'supplied' } });
  await second;
  requests[0].resolve({ ok: true, task: { id: 10, name: 'Old editable', status: 'doing', isMine: true, readOnly: false, children: [], childrenState: 'supplied' } });
  await first;
  assert.match(ui.node('dt-body').textContent, /New reference/);
  assert.equal(ui.node('dt-foot').querySelectorAll('.primary').length, 0);
  const last = ui.openDetail({ id: 11 });
  ui.closeDetail();
  requests[2].resolve({ ok: true, task: { id: 11, name: 'After close', children: [] } });
  await last;
  assert.equal(ui.DT.open, false);
  assert.equal(ui.DT.data, null);
  assert.equal(ui.node('detail').hidden, true);
});

test('tree and detail bridge rejections are retryable without leaving old write controls', async () => {
  let reject = true;
  const task = { id: 10, name: 'Recovered', status: 'doing', children: [], childrenState: 'supplied', isMine: true, readOnly: false };
  const ui = rendererFixture(async () => { if (reject) throw new Error('bridge offline'); return { ok: true, task }; });
  const row = ui.row({ ...task, parent: -1 }), button = row.querySelectorAll('.expander')[0];
  await ui.toggleTree(row, task, button);
  assert.equal(button.disabled, false);
  assert.equal(row.nextElementSibling, undefined);
  await ui.openDetail({ id: 10 });
  assert.match(ui.node('dt-body').textContent, /读取任务失败/);
  assert.equal(ui.node('dt-foot').hidden, true);
  reject = false;
  await ui.loadDetail(10);
  assert.equal(ui.node('dt-foot').querySelectorAll('.primary').length, 1);
  reject = true;
  await ui.loadDetail(10);
  assert.equal(ui.node('dt-foot').hidden, true);
  assert.equal(ui.DT.data, null);
});

test('detail response for previous id cannot replace newly navigated task', async () => {
  const old = deferred();
  const ui = rendererFixture(id => id === 10 ? old.promise : Promise.resolve({ ok: true, task: { id: 11, name: 'Current reference', status: 'doing', children: [], childrenState: 'supplied', isMine: false, readOnly: true } }));
  const first = ui.openDetail({ id: 10 });
  await ui.openDetail({ id: 11 });
  old.resolve({ ok: true, task: { id: 10, name: 'Old self task', status: 'doing', children: [], childrenState: 'supplied', isMine: true, readOnly: false } });
  await first;
  assert.equal(ui.DT.id, 11);
  assert.match(ui.node('dt-body').textContent, /Current reference/);
  assert.equal(ui.node('dt-foot').querySelectorAll('.primary').length, 0);
});

test('existing Windows list fixture supplies explicit self ownership for its editable detail flow', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-task-list-contract-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const handlers = new Map();
  const source = path.resolve(__dirname, 'fixtures/task-list.cjs');
  const electron = {
    app: { setPath() {}, whenReady: () => ({ then() {} }) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: class { constructor() { assert.fail('contract test must not start a GUI'); } },
  };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    require: name => name === 'electron' ? electron : require(name),
    __dirname: path.dirname(source), process: { env: { ZT_WINDOW_TEST_DIR: directory } },
    setTimeout() { assert.fail('contract test must not poll'); }, console,
  }, { filename: source });
  const result = handlers.get('task:detail')({}, 2);
  assert.equal(result.ok, true);
  assert.equal(result.task.isMine, true);
  assert.equal(result.task.readOnly, false);
  const ui = rendererFixture();
  ui.renderDetail(result.task);
  const button = ui.node('dt-foot').querySelectorAll('.primary')[0];
  assert.equal(button.textContent, '关闭任务');
  await button.click();
  assert.equal(ui.pending().it.id, 2);
});
