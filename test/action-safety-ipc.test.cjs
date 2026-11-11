'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mainFixture } = require('./fixtures/task-children.cjs');

const task = (extra = {}) => ({ id: 10, name: 'Fixture task', status: 'wait', deleted: false, assignedTo: 'Me', consumed: 0, parent: 0, ...extra });
const bug = (extra = {}) => ({ id: 20, title: 'Fixture bug', status: 'active', deleted: false, ...extra });
const taskRequest = (action, extra = {}) => ({ id: 10, action, payload: action === 'start' ? { consumed: 0, left: 2 } : action === 'finish' ? { currentConsumed: 1, left: 0 } : { closedReason: 'done' }, ...extra });
const bugRequest = (action, extra = {}) => ({ id: 20, action, payload: action === 'resolve' ? { resolution: 'fixed', resolvedBuild: 'trunk' } : { comment: '' }, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function addBug(f, record = bug()) {
  let current = record;
  f.client.bugReads = [];
  f.client.getBugDetail = async id => {
    f.client.bugReads.push(id);
    if (current instanceof Error) throw current;
    return current;
  };
  f.client.bugUrl = id => `https://zentao.invalid/bug-view-${id}.html`;
  f.client.resolveBug = async (id, payload) => {
    f.writes.push({ method: 'resolveBug', id, payload });
    current = { ...current, status: 'resolved' };
  };
  f.client.closeBug = async (id, comment) => {
    f.writes.push({ method: 'closeBug', id, payload: { comment } });
    current = { ...current, status: 'closed' };
  };
  return { get current() { return current; }, set current(value) { current = value; } };
}

function countRefreshes(f) {
  let refreshes = 0;
  const fetch = f.client.fetchMyTasks.bind(f.client);
  f.client.fetchMyTasks = async () => { refreshes++; return fetch(); };
  return () => refreshes;
}

test('stale, missing, unknown, and deleted task states reject without mutation and refresh the list', async () => {
  const cases = [
    [task({ status: 'wait' }), 'finish'],
    [task({ status: 'doing' }), 'start'],
    [task({ status: 'done' }), 'finish'],
    [task({ status: 'pause' }), 'start'],
    [task({ status: 'closed' }), 'start'],
    [task({ status: 'cancel' }), 'start'],
    [task({ status: undefined }), 'start'],
    [task({ status: 'future-status' }), 'start'],
    [task({ status: 'wait', deleted: true }), 'start'],
    [task({ deleted: 'unknown' }), 'start'],
  ];
  for (const [record, action] of cases) {
    const f = mainFixture([record]);
    const refreshes = countRefreshes(f);
    const result = await f.invoke('task:action', taskRequest(action));
    assert.equal(result.ok, false, `${record.status}/${record.deleted} ${action}`);
    assert.equal(result.outcome, 'rejected');
    assert.equal(f.writes.length, 0);
    assert.equal(refreshes(), 1, 'state mismatch requests a fresh list');
  }
});

test('only the established task and bug transitions dispatch; bug permission stays server-side', async () => {
  const f = mainFixture([task({ status: 'wait' })]);
  const count = countRefreshes(f);
  assert.equal((await f.invoke('task:action', taskRequest('start'))).outcome, 'verified');
  f.tasks.set(10, task({ status: 'doing' }));
  assert.equal((await f.invoke('task:action', taskRequest('finish'))).outcome, 'verified');
  f.tasks.set(10, task({ status: 'done' }));
  assert.equal((await f.invoke('task:action', taskRequest('close'))).outcome, 'verified');
  assert.deepEqual(f.writes.map(write => write.method), ['startTask', 'finishTask', 'closeTask']);

  const b = addBug(f, bug({ status: 'active', assignedTo: 'server-controlled-owner' }));
  assert.equal((await f.invoke('bug:action', bugRequest('resolve'))).outcome, 'verified');
  b.current = bug({ status: 'resolved', assignedTo: 'server-controlled-owner' });
  assert.equal((await f.invoke('bug:action', bugRequest('close'))).outcome, 'verified');
  assert.deepEqual(f.writes.slice(3).map(write => write.method), ['resolveBug', 'closeBug']);
  assert.equal(count(), 5);
});

test('invalid action payloads, bug ids, senders and subframes reject before details or writes', async () => {
  const f = mainFixture([task()]);
  addBug(f);
  for (const request of [
    taskRequest('start', { id: '10' }), taskRequest('start', { id: 0 }),
    taskRequest('start', { payload: { consumed: -1, left: 2 } }),
    taskRequest('start', { payload: { consumed: 0, left: 0 } }),
    taskRequest('close', { payload: { closedReason: 'cancel' } }),
    { id: '../20', action: 'resolve', payload: {} },
    bugRequest('resolve', { id: '20' }), bugRequest('resolve', { id: 0 }),
    bugRequest('resolve', { payload: { duplicateBug: '3bad' } }),
    bugRequest('resolve', { payload: { resolution: 'duplicate', duplicateBug: 0 } }),
    bugRequest('close', { payload: { delete: true } }),
  ]) {
    const result = await f.invoke(request.id === 20 || request.action === 'resolve' ? 'bug:action' : 'task:action', request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.outcome, 'rejected');
  }
  for (const sender of [null, {}, { ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) {
    assert.equal((await f.invoke('task:action', taskRequest('start'), sender)).ok, false);
    assert.equal((await f.invoke('bug:action', bugRequest('resolve'), sender)).ok, false);
  }
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.client.bugReads, []);
  assert.deepEqual(f.writes, []);
});

test('mock bug flow stays local while validating source, id, action and payload before the demo result', async () => {
  const f = mainFixture([], { argv: ['--mock'] });
  f.client.getBugDetail = async () => assert.fail('mock bug action must not read a real service');
  f.client.resolveBug = async () => assert.fail('mock bug action must not write a real service');
  f.client.closeBug = async () => assert.fail('mock bug action must not write a real service');
  for (const request of [
    bugRequest('resolve', { id: '20' }),
    bugRequest('resolve', { id: 0 }),
    bugRequest('resolve', { payload: { resolution: 'duplicate', duplicateBug: 'bad' } }),
    bugRequest('delete'),
  ]) {
    assert.equal((await f.invoke('bug:action', request)).ok, false);
  }
  assert.equal((await f.invoke('bug:action', bugRequest('resolve'))).outcome, 'verified');
  assert.equal((await f.invoke('bug:action', bugRequest('close'))).outcome, 'verified');
  for (const sender of [null, {}, { ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) {
    assert.equal((await f.invoke('bug:action', bugRequest('resolve'), sender)).ok, false);
  }
  assert.deepEqual(f.client.bugReads || [], []);
  assert.deepEqual(f.writes, []);
});

test('preflight and postflight reads reject stale or invalid task and bug records before dispatch', async () => {
  const badTaskRecords = [new Error('read denied'), { ...task(), id: 99 }, null, task({ assignedTo: 'someone-else' }), task({ status: 'wait', deleted: true })];
  for (const record of badTaskRecords) {
    const f = mainFixture([task()]);
    if (record instanceof Error) f.tasks.set(10, record);
    else f.tasks.set(10, record);
    const result = await f.invoke('task:action', taskRequest('start'));
    assert.equal(result.ok, false);
    assert.equal(f.writes.length, 0);
  }
  for (const record of [new Error('read denied'), { ...bug(), id: 21 }, null, bug({ status: 'resolved' }), bug({ status: 'active', deleted: true })]) {
    const f = mainFixture([task()]);
    addBug(f, record);
    const result = await f.invoke('bug:action', bugRequest('resolve'));
    assert.equal(result.ok, false);
    assert.equal(f.writes.length, 0);
  }
});

for (const [label, verification] of [
  ['wrong id', () => ({ ...task({ status: 'doing' }), id: 11 })],
  ['null', () => null],
  ['read throws', () => { throw new Error('verification unavailable'); }],
  ['missing status', () => ({ id: 10 })],
  ['deleted', () => task({ status: 'doing', deleted: true })],
  ['unknown deletion flag', () => task({ status: 'doing', deleted: 'unknown' })],
  ['unexpected status', () => task({ status: 'wait' })],
]) {
  test(`task post-write ${label} is unknown, never success or replay`, async () => {
    const f = mainFixture([task()]);
    let reads = 0;
    f.client.getTaskDetail = async id => {
      f.reads.push(id);
      reads++;
      if (reads === 1) return task();
      return verification();
    };
    f.client.startTask = async (id, payload) => f.writes.push({ method: 'startTask', id, payload });
    const result = await f.invoke('task:action', taskRequest('start'));
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.retrySafe, false);
    assert.equal(f.writes.length, 1);
    assert.equal(reads, 2);
  });
}

test('bug post-write failure to verify also stays unknown and is never replayed', async () => {
  const f = mainFixture([task()]);
  let reads = 0;
  addBug(f, bug());
  f.client.getBugDetail = async id => {
    f.client.bugReads.push(id);
    reads++;
    if (reads === 1) return bug();
    throw new Error('verification unavailable');
  };
  const result = await f.invoke('bug:action', bugRequest('resolve'));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.retrySafe, false);
  assert.equal(f.writes.length, 1);
  assert.equal(reads, 2);
});

test('write transport error after dispatch is unknown and the write is not replayed', async () => {
  const f = mainFixture([task()]);
  let writes = 0;
  f.client.startTask = async () => { writes++; throw new Error('connection reset after submit'); };
  const result = await f.invoke('task:action', taskRequest('start'));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.retrySafe, false);
  assert.equal(writes, 1);
  assert.equal(f.reads.length, 2, 'read back once without replaying the write');
  assert.equal((await f.invoke('task:action', taskRequest('start'))).outcome, 'unknown');
  assert.equal(writes, 1);
});

for (const action of ['close', 'assign']) {
  test(`${action} response lost after server commit is verified with one readback and no replay`, async () => {
    const f = assignmentFixture(task({ status: 'done' }));
    const method = action === 'assign' ? 'assignTask' : 'closeTask';
    f.client[method] = async (id, payload) => {
      f.writes.push({ method, id, payload });
      f.tasks.set(id, { ...f.tasks.get(id), ...(action === 'assign' ? { assignedTo: 'next' } : { status: 'closed' }) });
      throw new Error('connection reset after server commit');
    };
    const request = action === 'assign' ? assignmentRequest('next') : taskRequest('close');
    const result = await f.invoke('task:action', request);
    assert.equal(result.outcome, 'verified');
    assert.equal(result.ok, true);
    assert.equal(f.writes.length, 1);
    assert.equal(f.reads.length, 2);
    assert.equal(result.status, action === 'assign' ? 'done' : 'closed');
  });
}

for (const verification of ['unchanged', 'wrong id', 'wrong state', 'deleted', 'unreadable']) {
  test(`lost assignment response with ${verification} readback remains blocked`, async () => {
    const f = assignmentFixture();
    f.client.assignTask = async (id, payload) => {
      f.writes.push({ method: 'assignTask', id, payload });
      const latest = task({ status: 'done', assignedTo: 'Me' });
      if (verification === 'unchanged') latest.assignedTo = 'other';
      if (verification === 'wrong id') latest.id = 11;
      if (verification === 'wrong state') latest.status = 'closed';
      if (verification === 'deleted') latest.deleted = true;
      f.tasks.set(id, verification === 'unreadable' ? new Error('readback unavailable') : latest);
      throw new Error('connection reset after submit');
    };
    const result = await f.invoke('task:action', assignmentRequest());
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.retrySafe, false);
    assert.equal(f.reads.length, 2);
    assert.equal((await f.invoke('task:action', assignmentRequest())).outcome, 'unknown');
    assert.equal(f.writes.length, 1);
  });
}

test('lost bug close response is verified only by fresh closed detail', async () => {
  const f = mainFixture();
  const b = addBug(f, bug({ status: 'resolved' }));
  f.client.closeBug = async (id, comment) => {
    f.writes.push({ method: 'closeBug', id, payload: { comment } });
    b.current = bug({ status: 'closed' });
    throw new Error('connection reset after server commit');
  };
  const result = await f.invoke('bug:action', bugRequest('close'));
  assert.equal(result.outcome, 'verified');
  assert.equal(f.client.bugReads.length, 2);
  assert.equal(f.writes.length, 1);
});

test('write rejection before dispatch is not reconciled as a submitted write', async () => {
  const f = mainFixture([task({ status: 'done' })]);
  f.client.closeTask = async () => { throw Object.assign(new Error('authentication failed'), { outcome: 'rejected' }); };
  const result = await f.invoke('task:action', taskRequest('close'));
  assert.equal(result.outcome, 'rejected');
  assert.equal(f.reads.length, 1);
  assert.equal(f.writes.length, 0);
});

test('unknown outcomes remain blocked until an explicit fresh valid detail read', async () => {
  const f = mainFixture([task()]);
  let reads = 0;
  f.client.getTaskDetail = async id => {
    f.reads.push(id);
    reads++;
    if (reads === 2) return null; // first write dispatched; postflight inconclusive
    return task();
  };
  f.client.startTask = async (id, payload) => f.writes.push({ method: 'startTask', id, payload });
  const uncertain = await f.invoke('task:action', taskRequest('start'));
  assert.equal(uncertain.outcome, 'unknown');
  assert.equal((await f.invoke('task:action', taskRequest('start'))).outcome, 'unknown');
  assert.equal(f.writes.length, 1);
  assert.equal((await f.invoke('task:detail', 10)).ok, true);
  assert.equal((await f.invoke('task:action', taskRequest('start'))).outcome, 'unknown');
  // The third action again has an inconclusive postflight in this fixture; it was dispatched only because detail cleared the block.
  assert.equal(f.writes.length, 2);
});

test('unknown bug outcome remains blocked until explicit fresh bug detail read', async () => {
  const f = mainFixture([task()]);
  const record = addBug(f, bug());
  let reads = 0;
  f.client.getBugDetail = async id => {
    f.client.bugReads.push(id);
    reads++;
    if (reads === 2) return null;
    return record.current;
  };
  const uncertain = await f.invoke('bug:action', bugRequest('resolve'));
  assert.equal(uncertain.outcome, 'unknown');
  assert.equal((await f.invoke('bug:action', bugRequest('resolve'))).outcome, 'unknown');
  assert.equal(f.writes.length, 1);
  record.current = bug({ status: 'active' }); // latest server detail says the resolve did not take effect
  assert.equal((await f.invoke('bug:detail', 20)).ok, true);
  assert.equal((await f.invoke('bug:action', bugRequest('resolve'))).outcome, 'verified');
  assert.equal(f.writes.length, 2);
});

test('in-flight duplicate is pending while first preflight is unresolved', async () => {
  const f = mainFixture([task()]);
  const gate = deferred();
  let reads = 0;
  f.client.getTaskDetail = async id => {
    f.reads.push(id);
    reads++;
    return reads === 1 ? gate.promise : task({ status: 'doing' });
  };
  const first = f.invoke('task:action', taskRequest('start'));
  await Promise.resolve();
  const second = await f.invoke('task:action', taskRequest('start'));
  assert.equal(second.outcome, 'pending');
  assert.equal(second.retrySafe, false);
  assert.equal(f.writes.length, 0);
  gate.resolve(task());
  assert.equal((await first).outcome, 'verified');
  assert.equal(f.writes.length, 1);
  assert.equal(f.reads.length, 2);
});

test('connection config save is refused during preflight without changing account or client', async () => {
  const f = mainFixture([task()]);
  const gate = deferred();
  f.client.getTaskDetail = async id => { f.reads.push(id); return gate.promise; };
  const originalClient = f.client;
  const first = f.invoke('task:action', taskRequest('start'));
  await Promise.resolve();
  const blocked = await f.invoke('config:save', { baseUrl: 'https://other.invalid', account: 'Mallory', password: 'new-secret' });
  assert.equal(blocked.ok, false);
  assert.strictEqual(f.client, originalClient);
  assert.equal(blocked.config.baseUrl, 'https://zentao.invalid');
  assert.equal(blocked.config.account, 'Me');
  gate.resolve(task());
  await first;
  assert.deepEqual(f.writes.map(write => write.method), ['startTask']);
});

for (const kind of ['task', 'bug']) {
  test(`a ${kind} detail request begun before a write becomes uncertain cannot clear its later unknown lock`, async () => {
    const f = mainFixture([task()]);
    const current = kind === 'task' ? task() : null;
    if (kind === 'bug') addBug(f, bug());
    const id = kind === 'task' ? 10 : 20;
    const detailChannel = `${kind}:detail`;
    const actionChannel = `${kind}:action`;
    const request = kind === 'task' ? taskRequest('start') : bugRequest('resolve');
    const detail = kind === 'task' ? f.client.getTaskDetail.bind(f.client) : f.client.getBugDetail.bind(f.client);
    const gate = deferred();
    let reads = 0;
    const fakeDetail = async requestedId => {
      reads++;
      if (reads === 1) return gate.promise;
      if (reads === 2) return kind === 'task' ? current : bug();
      if (reads === 3) return null;
      return detail(requestedId);
    };
    if (kind === 'task') {
      f.client.getTaskDetail = fakeDetail;
      f.client.startTask = async (taskId, payload) => f.writes.push({ method: 'startTask', id: taskId, payload });
    } else {
      f.client.getBugDetail = fakeDetail;
      f.client.resolveBug = async (bugId, payload) => f.writes.push({ method: 'resolveBug', id: bugId, payload });
    }

    const oldDetail = f.invoke(detailChannel, id);
    const result = await f.invoke(actionChannel, request);
    assert.equal(result.outcome, 'unknown');
    gate.resolve(kind === 'task' ? current : bug());
    assert.equal((await oldDetail).ok, true);
    assert.equal((await f.invoke(actionChannel, request)).outcome, 'unknown');
    assert.equal(f.writes.length, 1, 'pre-write detail completion cannot unlock or duplicate the uncertain write');
  });

  test(`a ${kind} detail with unknown deleted state cannot clear an uncertain-write lock`, async () => {
    const f = mainFixture([task()]);
    const row = kind === 'task' ? task() : bug();
    if (kind === 'bug') addBug(f, row);
    const detailChannel = `${kind}:detail`;
    const actionChannel = `${kind}:action`;
    const request = kind === 'task' ? taskRequest('start') : bugRequest('resolve');
    let reads = 0;
    const get = async () => {
      reads++;
      if (reads === 2) return null; // post-write verification cannot confirm outcome
      if (reads === 3) return kind === 'task' ? task({ deleted: 'unknown' }) : bug({ deleted: 'unknown' });
      return kind === 'task' ? task() : bug();
    };
    if (kind === 'task') {
      f.client.getTaskDetail = get;
      f.client.startTask = async (id, payload) => f.writes.push({ method: 'startTask', id, payload });
    } else {
      f.client.getBugDetail = get;
      f.client.resolveBug = async (id, payload) => f.writes.push({ method: 'resolveBug', id, payload });
    }
    const uncertain = await f.invoke(actionChannel, request);
    assert.equal(uncertain.outcome, 'unknown');
    const detailResult = await f.invoke(detailChannel, kind === 'task' ? 10 : 20);
    assert.equal(detailResult.ok, true);
    assert.equal((await f.invoke(actionChannel, request)).outcome, 'unknown');
    assert.equal(f.writes.length, 1);
  });

  test(`${kind} action preflight refuses a valid-looking status when deleted is invalid`, async () => {
    const f = mainFixture([task({ deleted: 'unknown' })]);
    if (kind === 'task') {
      f.client.getTaskDetail = async () => task({ deleted: 'unknown' });
    } else {
      addBug(f, bug({ deleted: 'unknown' }));
      f.client.getBugDetail = async () => bug({ deleted: 'unknown' });
    }
    const result = await f.invoke(`${kind}:action`, kind === 'task' ? taskRequest('start') : bugRequest('resolve'));
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'rejected');
    assert.equal(f.writes.length, 0);
  });
}

for (const kind of ['task', 'bug']) {
  test(`an older ${kind} detail cannot clear a newer uncertainty generation`, async () => {
    const f = mainFixture([task()]);
    const id = kind === 'task' ? 10 : 20;
    const detailChannel = `${kind}:detail`;
    const actionChannel = `${kind}:action`;
    const request = kind === 'task' ? taskRequest('start') : bugRequest('resolve');
    const row = kind === 'task' ? task() : bug();
    if (kind === 'bug') addBug(f, row);
    const gate = deferred();
    let reads = 0;
    const current = async requestedId => {
      reads++;
      if (reads === 2 || reads === 6) return null; // verification for each write is inconclusive
      if (reads === 3) return gate.promise; // stale detail captured generation 1
      return kind === 'task' ? task() : bug();
    };
    if (kind === 'task') {
      f.client.getTaskDetail = current;
      f.client.startTask = async (taskId, payload) => f.writes.push({ method: 'startTask', id: taskId, payload });
    } else {
      f.client.getBugDetail = current;
      f.client.resolveBug = async (bugId, payload) => f.writes.push({ method: 'resolveBug', id: bugId, payload });
    }

    assert.equal((await f.invoke(actionChannel, request)).outcome, 'unknown'); // generation 1
    const stale = f.invoke(detailChannel, id); // captures generation 1, then waits
    assert.equal((await f.invoke(detailChannel, id)).ok, true); // independent fresh detail clears generation 1
    assert.equal((await f.invoke(actionChannel, request)).outcome, 'unknown'); // generation 2
    gate.resolve(kind === 'task' ? task() : bug());
    assert.equal((await stale).ok, true);
    assert.equal((await f.invoke(actionChannel, request)).outcome, 'unknown');
    assert.equal(f.writes.length, 2, 'stale generation-1 response cannot clear the generation-2 lock');
  });
}

test('connection switch clears old list, ignores stale refresh completion, then populates from the new connection', async () => {
  const f = mainFixture([], { allowConfigSave: true });
  const oldResponse = deferred();
  let oldCalls = 0, newCalls = 0;
  f.client.fetchMyTasks = async () => {
    if (f.config().baseUrl === 'https://server-b.invalid') {
      newCalls++;
      return { items: [{ id: 22, kind: 'task', name: 'Server B item', status: 'wait' }], strategy: 'fixture-b' };
    }
    oldCalls++;
    if (oldCalls === 1) return { items: [{ id: 11, kind: 'task', name: 'Initial server A item', status: 'wait' }], strategy: 'fixture-a' };
    return oldResponse.promise;
  };
  f.client.fetchMyBugs = async () => ({ items: [] });

  await f.invoke('zentao:refresh');
  assert.deepEqual(Array.from(f.state().items, item => item.id), [11]);
  const staleRefresh = f.invoke('zentao:refresh');
  await Promise.resolve();
  assert.equal(oldCalls, 2);
  const saved = await f.invoke('config:save', { baseUrl: 'https://server-b.invalid', account: 'Bob' });
  assert.ok(saved.state);
  assert.equal(f.config().baseUrl, 'https://server-b.invalid');
  assert.equal(f.state().items.length, 0, 'old connection items are cleared immediately');
  assert.ok(f.diskWrites.some(entry => entry.method === 'writeFileSync'));
  assert.ok(f.intervals.length > 0);
  assert.ok(f.intervals.every(interval => typeof interval.fn === 'function'), 'poll callback is recorded, never executed');

  oldResponse.resolve({ items: [{ id: 11, kind: 'task', name: 'Stale server A item', status: 'wait' }], strategy: 'fixture-a' });
  await staleRefresh;
  assert.equal(f.state().items.length, 0, 'late result from connection A cannot repopulate the list');
  assert.ok(f.scheduledTimeouts.length > 0, 'connection change queues a fresh read');

  await f.runScheduledTimeouts();
  assert.equal(newCalls, 1);
  assert.deepEqual(Array.from(f.state().items, item => item.id), [22]);
  assert.equal(f.state().items[0].name, 'Server B item');
  assert.deepEqual(f.diskWrites.filter(entry => entry.method === 'writeFileSync').map(entry => entry.args[0]), [
    require('node:path').join(require('node:os').tmpdir(), 'zentao-config-save-fixture-only', 'config.json'),
  ]);
});

test('detail started on the old connection returns false and cannot clear that connection’s unknown action lock', async () => {
  const f = mainFixture([task()], { allowConfigSave: true });
  const oldDetail = deferred();
  let reads = 0;
  f.client.getTaskDetail = async () => {
    reads++;
    if (reads === 1) return task();
    if (reads === 2) return null;
    if (reads === 3) return oldDetail.promise;
    return task();
  };
  f.client.startTask = async (id, payload) => f.writes.push({ method: 'startTask', id, payload });
  const action = await f.invoke('task:action', taskRequest('start'));
  assert.equal(action.outcome, 'unknown');

  const stale = f.invoke('task:detail', 10);
  await Promise.resolve();
  const switched = await f.invoke('config:save', { baseUrl: 'https://server-b.invalid', account: 'Bob' });
  assert.ok(switched.config);
  oldDetail.resolve(task());
  const result = await stale;
  assert.equal(result.ok, false);
  assert.match(result.error, /连接配置已变化/);

  await f.invoke('config:save', { baseUrl: 'https://zentao.invalid', account: 'Me' });
  assert.equal((await f.invoke('task:action', taskRequest('start'))).outcome, 'unknown');
  assert.equal(f.writes.length, 1, 'stale old-connection detail did not clear the lock');
});

test('authentication already in flight cannot put the old account token into a new connection client', async () => {
  const f = mainFixture([task()], { allowConfigSave: true });
  const auth = deferred();
  const old = f.currentClient();
  old.ensureToken = async function () {
    this.token = await auth.promise;
    return this.token;
  };
  const pendingAuth = old.ensureToken();
  await f.invoke('config:save', { account: 'FixtureB' });
  const next = f.currentClient();
  assert.notEqual(next, old, 'identity change replaces rather than mutates the client');
  assert.equal(old.cfg.account, 'Me');
  assert.equal(next.cfg.account, 'FixtureB');
  assert.equal(next.token, null);
  auth.resolve('synthetic-old-token');
  await pendingAuth;
  assert.equal(old.token, 'synthetic-old-token');
  assert.equal(next.token, null, 'a late old-account authentication cannot contaminate the new client');
});

test('omitted deletion flag preserves existing main task and bug operations', async () => {
  const f = mainFixture([task({ deleted: undefined })]);
  addBug(f, bug({ deleted: undefined }));
  assert.equal((await f.invoke('task:action', taskRequest('start'))).ok, true);
  assert.equal((await f.invoke('bug:action', bugRequest('resolve'))).ok, true);
});

function assignmentFixture(record = task({ status: 'done', assignedTo: 'other' })) {
  const f = mainFixture([record], { allowConfigSave: true });
  f.client.listUsers = async () => [{ account: 'Me', realname: '我' }, { account: 'next', realname: '下一位' }];
  f.client.assignTask = async (id, payload) => {
    f.writes.push({ method: 'assignTask', id, payload });
    f.tasks.set(id, { ...f.tasks.get(id), assignedTo: { account: payload.assignedTo } });
  };
  return f;
}
const assignmentRequest = (assignedTo = 'Me') => ({ id: 10, action: 'assign', payload: { assignedTo } });

test('reference and completed tasks allow assignment while status actions remain owner-only', async () => {
  const f = assignmentFixture();
  const detail = await f.invoke('task:detail', 10);
  assert.equal(detail.task.canAssign, true);
  assert.equal(detail.task.readOnly, true);
  assert.equal(detail.task.assignedTo, 'other');
  assert.equal((await f.invoke('task:action', taskRequest('close'))).outcome, 'rejected');
  assert.equal((await f.invoke('task:assignees', 10)).users.length, 2);
  assert.equal((await f.invoke('task:action', assignmentRequest())).outcome, 'verified');
  assert.equal(f.tasks.get(10).status, 'done');
  assert.equal(f.tasks.get(10).assignedTo.account, 'Me');
  assert.equal(f.writes.length, 1);
  assert.equal((await f.invoke('task:detail', 10)).task.readOnly, false);
  assert.equal((await f.invoke('task:action', assignmentRequest('next'))).outcome, 'verified');
  assert.equal((await f.invoke('task:detail', 10)).task.readOnly, true);
});

test('assignment rejects invalid sources, ids, users and unavailable records without writing', async () => {
  const f = assignmentFixture();
  for (const event of [null, {}, { ...f.event, senderFrame: {} }]) {
    assert.equal((await f.invoke('task:assignees', 10, event)).ok, false);
    assert.equal((await f.invoke('task:action', assignmentRequest(), event)).outcome, 'rejected');
  }
  for (const id of [0, '10', -1]) assert.equal((await f.invoke('task:assignees', id)).ok, false);
  for (const payload of [{}, { assignedTo: 'unknown' }, { assignedTo: 'other' }, { assignedTo: 'Me', status: 'doing' }]) {
    assert.equal((await f.invoke('task:action', { ...assignmentRequest(), payload })).outcome, 'rejected');
  }
  for (const record of [task({ deleted: true }), task({ status: 'unknown' }), { ...task(), id: 99 }]) {
    f.tasks.set(10, record);
    assert.equal((await f.invoke('task:assignees', 10)).ok, false);
    assert.equal((await f.invoke('task:action', assignmentRequest())).outcome, 'rejected');
  }
  assert.equal(f.writes.length, 0);
});

test('assignment shares the write lock and blocks connection changes while awaiting dispatch', async () => {
  const f = assignmentFixture();
  const gate = deferred();
  f.client.assignTask = async (id, payload) => {
    f.writes.push({ method: 'assignTask', id, payload });
    await gate.promise;
    f.tasks.get(id).assignedTo = payload.assignedTo;
  };
  const first = f.invoke('task:action', assignmentRequest());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.invoke('task:action', assignmentRequest())).outcome, 'pending');
  assert.equal((await f.invoke('config:save', { account: 'another' })).ok, false);
  assert.equal(f.writes.length, 1);
  gate.resolve();
  assert.equal((await first).outcome, 'verified');
});

test('unchanged assignee or failed readback stays unknown and never automatically retries', async () => {
  for (const unreadable of [false, true]) {
    const f = assignmentFixture();
    f.client.assignTask = async (id, payload) => {
      f.writes.push({ method: 'assignTask', id, payload });
      if (unreadable) f.tasks.set(id, new Error('readback unavailable'));
    };
    const result = await f.invoke('task:action', assignmentRequest());
    assert.equal(result.outcome, 'unknown');
    assert.equal((await f.invoke('task:action', assignmentRequest())).outcome, 'unknown');
    assert.equal(f.writes.length, 1);
    f.tasks.set(10, task({ status: 'done', assignedTo: 'other' }));
    assert.equal((await f.invoke('task:detail', 10)).task.writeStateKnown, true);
    assert.equal((await f.invoke('task:action', assignmentRequest())).outcome, 'unknown');
    assert.equal(f.writes.length, 2, 'only a fresh detail permits another explicit attempt');
  }
});

test('stale assignee response is discarded after changing connection', async () => {
  const f = assignmentFixture();
  const gate = deferred();
  f.client.listUsers = () => gate.promise;
  const read = f.invoke('task:assignees', 10);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.invoke('config:save', { account: 'another' })).config.account, 'another');
  gate.resolve([{ account: 'old-connection-user', realname: 'Old' }]);
  assert.equal((await read).ok, false);
});
for (const mode of ['task', 'assign', 'bug']) {
  for (const outcome of ['verified', 'unknown']) {
    test(`${mode} ${outcome} result and write lock settle before a slow list refresh`, async () => {
      const f = mode === 'assign' ? assignmentFixture() : mainFixture([task()]);
      const refresh = deferred();
      let refreshes = 0;
      f.client.fetchMyTasks = () => { refreshes++; return refresh.promise; };
      if (mode === 'bug') addBug(f);
      if (outcome === 'unknown') {
        const write = mode === 'assign' ? 'assignTask' : mode === 'bug' ? 'resolveBug' : 'startTask';
        f.client[write] = async (id, payload) => { f.writes.push({ method: write, id, payload }); };
      }
      const channel = mode === 'bug' ? 'bug:action' : 'task:action';
      const request = mode === 'assign' ? assignmentRequest() : mode === 'bug' ? bugRequest('resolve') : taskRequest('start');
      let result;
      const first = f.invoke(channel, request).then(value => { result = value; return value; });
      try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(refreshes, 1, 'list refresh is still requested');
        assert.equal(result?.outcome, outcome, 'a slow list cannot delay the known operation result');
        assert.equal((await f.invoke(channel, request)).outcome, outcome === 'unknown' ? 'unknown' : 'rejected');
        assert.equal(f.writes.length, 1, 'refreshing never replays the write');
      } finally {
        refresh.resolve({ items: [], strategy: 'fixture' });
        await first;
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.state().ok, true, 'the asynchronous refresh still publishes list state');
    });
  }
}
