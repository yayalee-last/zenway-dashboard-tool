'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the renderer's real function declarations without Electron or network access.
// This deliberately exercises the renderer/resize contract, not native window geometry.
function rendererHarness({ innerHeight = 675, outerHeight = innerHeight, zoom = 1, listHeight = 675, detailOpen = false } = {}) {
  const elements = new Map();
  const resizeCalls = [];
  const writes = [];
  const bugWrites = [];
  const openedUrls = [];
  const detailReads = [];
  const listeners = new Map();
  const makeElement = (id) => ({
    id, hidden: true, value: '', textContent: '', disabled: false,
    offsetHeight: 0, clientHeight: 0, children: [], style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, fn) { this.listeners ||= {}; this.listeners[type] = fn; },
    focus() {}, select() {},
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const list = get('list');
  list.clientHeight = listHeight;
  list.children = listHeight ? [{ offsetHeight: listHeight }] : [];
  const shell = { offsetHeight: listHeight };
  const document = {
    getElementById: get,
    querySelector(selector) { return selector === '.shell' ? shell : get(selector); },
    addEventListener(type, fn) { listeners.set(type, fn); },
  };
  const window = {
    innerHeight, outerHeight,
    ItemOrder: require('../renderer/item-order'),
    zt: {
      resize(height) {
        resizeCalls.push(height);
        window.outerHeight = height;
        window.innerHeight = height / zoom;
      },
      taskAction(payload) { writes.push(payload); return window.taskActionResult ? window.taskActionResult(payload) : Promise.resolve({ ok: true, outcome: 'verified' }); },
      bugAction(payload) { bugWrites.push(payload); return window.bugActionResult ? window.bugActionResult(payload) : Promise.resolve({ ok: true, outcome: 'verified' }); },
      taskDetail(id) { detailReads.push(['task', id]); return Promise.resolve({ ok: true, task: { id } }); },
      bugDetail(id) { detailReads.push(['bug', id]); return Promise.resolve({ ok: true, bug: { id } }); },
      open(url) { openedUrls.push(url); },
      onState() {}, onOpenSettings() {}, onOpenItem() {}, onUpdate() {}, onOpenUpdate() {},
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8')
    .split('(async function init()')[0];
  const context = vm.createContext({
    window, document, console,
    requestAnimationFrame(fn) { fn(); },
    setTimeout() { return 1; },
    clearTimeout() {},
    getComputedStyle() { return { paddingTop: '0', paddingBottom: '0', rowGap: '0' }; },
  });
  vm.runInContext(source, context, { filename: 'renderer/app.js' });
  vm.runInContext(`DT.open = ${Boolean(detailOpen)}`, context);
  context.bind();
  return { context, get, listeners, resizeCalls, writes, bugWrites, openedUrls, detailReads, window };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('opening a close confirmation preserves a tall list instead of shrinking it below the pointer', () => {
  const h = rendererHarness({ innerHeight: 675, listHeight: 675 });
  h.context.openTaskAction('close', { id: 7, name: 'Completed fixture task', status: 'done' });
  assert.deepEqual(h.resizeCalls, [675]);
  assert.equal(h.get('task-modal').hidden, false);
  assert.equal(h.writes.length, 0);
});

test('opening a close confirmation grows a short list to the minimum dialog height', () => {
  const h = rendererHarness({ innerHeight: 180, listHeight: 180 });
  h.context.openTaskAction('close', { id: 8, name: 'Completed fixture task', status: 'done' });
  assert.deepEqual(h.resizeCalls, [320]);
  assert.equal(h.get('task-modal').hidden, false);
});

test('opening at 125% zoom preserves native window height, not scaled innerHeight', () => {
  const h = rendererHarness({ innerHeight: 540, outerHeight: 675, zoom: 1.25, listHeight: 675 });
  h.context.openTaskAction('close', { id: 10, name: 'Completed fixture task', status: 'done' });
  assert.deepEqual(h.resizeCalls, [675]);
});

test('cancel button, Escape, and backdrop dismiss without writing and restore list height', () => {
  for (const dismiss of [
    h => h.get('tm-cancel').listeners.click(),
    h => h.listeners.get('keydown')({ key: 'Escape' }),
    h => h.get('task-modal').listeners.click({ target: h.get('task-modal') }),
  ]) {
    const h = rendererHarness({ innerHeight: 675, listHeight: 675 });
    h.context.openTaskAction('close', { id: 9, name: 'Completed fixture task', status: 'done' });
    dismiss(h);
    assert.equal(h.get('task-modal').hidden, true);
    assert.equal(h.writes.length, 0);
    assert.equal(h.resizeCalls.at(-1), 675);
  }
});

test('confirmation is the only task write and dismissal restores detail height', async () => {
  const h = rendererHarness({ innerHeight: 675, listHeight: 675 });
  const item = { id: 9, name: 'Completed fixture task', status: 'done' };
  h.context.openTaskAction('close', item);
  h.get('tm-cancel').listeners.click();
  assert.equal(h.writes.length, 0);
  assert.equal(h.resizeCalls.at(-1), 675);

  h.context.openTaskAction('close', item);
  assert.match(h.get('tm-close-note').textContent, /不是删除/);
  await h.context.confirmTaskAction();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes[0])), { id: 9, action: 'close', payload: { comment: '' } });

  const detail = rendererHarness({ innerHeight: 600, listHeight: 675, detailOpen: true });
  detail.context.openTaskAction('close', item);
  assert.deepEqual(detail.resizeCalls, [600], 'opening from details must retain the current detail height');
  detail.get('tm-cancel').listeners.click();
  assert.equal(detail.resizeCalls.at(-1), 600);
});

test('task duplicate confirm and cancel/reopen while pending never send another write or touch newer dialog', async () => {
  const h = rendererHarness();
  const d = deferred();
  h.window.taskActionResult = () => d.promise;
  const item = { id: 41, name: 'task' };
  h.context.openTaskAction('finish', item);
  const first = h.context.confirmTaskAction();
  await h.context.confirmTaskAction();
  assert.equal(h.writes.length, 1);
  h.get('tm-cancel').listeners.click();
  h.context.openTaskAction('finish', item);
  const newError = h.get('tm-err').textContent;
  await h.context.confirmTaskAction();
  assert.equal(h.writes.length, 1);
  d.resolve({ ok: false, outcome: 'rejected', error: 'known failure' });
  await first;
  assert.equal(h.get('task-modal').hidden, false);
  assert.equal(h.get('tm-err').textContent, newError, 'old completion must not change a newer dialog');
  h.get('tm-cancel').listeners.click();
  h.window.taskActionResult = () => Promise.resolve({ ok: true, outcome: 'verified' });
  h.context.openTaskAction('finish', item);
  await h.context.confirmTaskAction();
  assert.equal(h.writes.length, 2);
});

test('task known rejection can retry; uncertain outcome and bridge rejection cannot', async () => {
  const h = rendererHarness();
  const item = { id: 42, name: 'task' };
  let n = 0;
  h.window.taskActionResult = () => Promise.resolve(++n === 1
    ? { ok: false, outcome: 'rejected', retrySafe: true, error: 'preflight rejected' }
    : { ok: true, outcome: 'verified' });
  h.context.openTaskAction('finish', item);
  await h.context.confirmTaskAction();
  assert.equal(h.get('tm-ok').disabled, false);
  await h.context.confirmTaskAction();
  assert.equal(h.writes.length, 2);

  const uncertain = rendererHarness();
  uncertain.window.taskActionResult = () => Promise.resolve({ ok: false, outcome: 'unknown', retrySafe: false, error: 'timeout' });
  uncertain.context.openTaskAction('finish', item);
  await uncertain.context.confirmTaskAction();
  await uncertain.context.confirmTaskAction();
  assert.equal(uncertain.writes.length, 1);
  assert.match(uncertain.get('tm-err').textContent, /禅道网页检查/);
  uncertain.get('tm-err').onclick();
  assert.match(uncertain.openedUrls[0], /task-view-42\.html$/);

  const rejectedBridge = rendererHarness();
  rejectedBridge.window.taskActionResult = () => Promise.reject(new Error('bridge dropped'));
  rejectedBridge.context.openTaskAction('finish', item);
  await rejectedBridge.context.confirmTaskAction();
  await rejectedBridge.context.confirmTaskAction();
  assert.equal(rejectedBridge.writes.length, 1);
  assert.match(rejectedBridge.get('tm-err').textContent, /操作结果未知/);
});

test('start task rejects zero remaining hours and points to checking the web record', async () => {
  const h = rendererHarness();
  h.context.openTaskAction('start', { id: 50, name: 'task', left: 0 });
  await h.context.confirmTaskAction();
  assert.equal(h.writes.length, 0);
  assert.match(h.get('tm-err').textContent, /禅道网页核对或完成/);
});

test('start dialog labels cumulative consumed hours and defaults only to the known total', async () => {
  const h = rendererHarness();
  h.context.openTaskAction('start', { id: 52, name: 'task', consumed: 1.5, left: 2 });
  assert.equal(h.get('tm-consumed-label').textContent, '总计消耗（小时）');
  assert.equal(h.get('tm-consumed').value, '1.5');
  await h.context.confirmTaskAction();
  assert.equal(h.writes[0].payload.consumed, 1.5);

  h.context.openTaskAction('start', { id: 53, name: 'no-history', left: 2 });
  assert.equal(h.get('tm-consumed').value, '0', 'do not invent consumed time');
});

test('finish action always submits zero remaining hours', async () => {
  const h = rendererHarness();
  h.context.openTaskAction('finish', { id: 51, name: 'task', left: 2 });
  assert.equal(h.get('tm-left').value, '0');
  assert.equal(h.get('tm-left').disabled, true);
  h.get('tm-left').value = '9';
  await h.context.confirmTaskAction();
  assert.equal(h.writes[0].payload.left, 0);
});

test('stale successful task and bug completions do not refresh a different current detail', async () => {
  for (const kind of ['task', 'bug']) {
    const h = rendererHarness({ detailOpen: true });
    const d = deferred();
    let completion;
    if (kind === 'task') {
      h.window.taskActionResult = () => d.promise;
      h.context.openTaskAction('finish', { id: 71, name: 'task', left: 1 });
      completion = h.context.confirmTaskAction();
      vm.runInContext("DT.kind = 'task'; DT.id = 72; DT.open = true", h.context);
      h.context.openTaskAction('start', { id: 72, name: 'newer task', left: 2 });
    } else {
      h.window.bugActionResult = () => d.promise;
      h.context.openBugAction('resolve', { id: 81, name: 'bug' });
      completion = h.context.confirmBugAction();
      vm.runInContext("DT.kind = 'bug'; DT.id = 82; DT.open = true", h.context);
      h.context.openBugAction('close', { id: 82, name: 'newer bug' });
      d.resolve({ ok: true, outcome: 'verified' });
      await completion;
      assert.deepEqual(h.detailReads, []);
      assert.equal(h.get('bug-modal').hidden, false);
      continue;
    }
    d.resolve({ ok: true, outcome: 'verified' });
    await completion;
    assert.deepEqual(h.detailReads, []);
    assert.equal(h.get('task-modal').hidden, false);
  }
});

test('uncertain action lock survives reopening until an explicit successful detail read', async () => {
  for (const kind of ['task', 'bug']) {
    const h = rendererHarness();
    if (kind === 'task') {
      h.window.taskActionResult = () => Promise.resolve({ ok: false, outcome: 'unknown', error: 'timeout' });
      h.context.openTaskAction('finish', { id: 91, name: 'task', left: 1 });
      await h.context.confirmTaskAction();
      h.context.closeTaskAction();
      h.context.openTaskAction('finish', { id: 91, name: 'task', left: 1 });
      assert.equal(h.get('tm-ok').disabled, true);
      vm.runInContext("renderDetail = () => {}; DT.open = true; DT.kind = 'task'; DT.id = 91", h.context);
      await h.context.loadDetail(91);
      h.context.closeTaskAction();
      h.context.openTaskAction('finish', { id: 91, name: 'task', left: 1 });
      assert.equal(h.get('tm-ok').disabled, false);
    } else {
      h.window.bugActionResult = () => Promise.resolve({ ok: false, outcome: 'unknown', error: 'timeout' });
      h.context.openBugAction('resolve', { id: 92, name: 'bug' });
      await h.context.confirmBugAction();
      h.context.closeBugAction();
      h.context.openBugAction('resolve', { id: 92, name: 'bug' });
      assert.equal(h.get('bm-ok').disabled, true);
      vm.runInContext("renderBugDetail = () => {}; DT.open = true; DT.kind = 'bug'; DT.id = 92", h.context);
      await h.context.loadBugDetail(92);
      h.context.closeBugAction();
      h.context.openBugAction('resolve', { id: 92, name: 'bug' });
      assert.equal(h.get('bm-ok').disabled, false);
    }
  }
});

test('bug duplicate/cancel/reopen, known retry, uncertain result, and rejected bridge are safe', async () => {
  const h = rendererHarness();
  const item = { id: 61, name: 'bug' };
  const d = deferred();
  h.window.bugActionResult = () => d.promise;
  h.context.openBugAction('resolve', item);
  const first = h.context.confirmBugAction();
  await h.context.confirmBugAction();
  h.get('bm-cancel').listeners.click();
  h.context.openBugAction('resolve', item);
  const err = h.get('bm-err').textContent;
  await h.context.confirmBugAction();
  assert.equal(h.bugWrites.length, 1);
  d.resolve({ ok: false, outcome: 'rejected', retrySafe: true, error: 'known' });
  await first;
  assert.equal(h.get('bug-modal').hidden, false);
  assert.equal(h.get('bm-err').textContent, err);
  h.get('bm-cancel').listeners.click();

  let calls = 0;
  h.window.bugActionResult = () => Promise.resolve(++calls === 1
    ? { ok: false, outcome: 'rejected', error: 'retryable' }
    : { ok: true, outcome: 'verified' });
  h.context.openBugAction('resolve', item);
  await h.context.confirmBugAction();
  await h.context.confirmBugAction();
  assert.equal(h.bugWrites.length, 3);

  h.get('bm-cancel').listeners.click();
  const uncertain = rendererHarness();
  uncertain.window.bugActionResult = () => Promise.resolve({ ok: false, outcome: 'unknown', error: 'timeout' });
  uncertain.context.openBugAction('close', item);
  await uncertain.context.confirmBugAction();
  await uncertain.context.confirmBugAction();
  assert.equal(uncertain.bugWrites.length, 1);
  assert.match(uncertain.get('bm-err').textContent, /禅道网页检查/);
  uncertain.get('bm-err').onclick();
  assert.match(uncertain.openedUrls[0], /m=bug&f=view&id=61$/);

  const bridge = rendererHarness();
  bridge.window.bugActionResult = () => Promise.reject(new Error('bridge dropped'));
  bridge.context.openBugAction('resolve', item);
  await bridge.context.confirmBugAction();
  await bridge.context.confirmBugAction();
  assert.equal(bridge.bugWrites.length, 1);
  assert.match(bridge.get('bm-err').textContent, /结果未知/);
});

test('detail reads started before an uncertain write cannot erase its newer retry warning', async () => {
  for (const kind of ['task', 'bug']) {
    const h = rendererHarness();
    const write = deferred(), read = deferred();
    const item = { id: 98, name: 'Synthetic record', left: 1 };
    const task = kind === 'task';
    const open = task ? 'openTaskAction' : 'openBugAction';
    const close = task ? 'closeTaskAction' : 'closeBugAction';
    const confirm = task ? 'confirmTaskAction' : 'confirmBugAction';
    const load = task ? 'loadDetail' : 'loadBugDetail';
    h.window[task ? 'taskActionResult' : 'bugActionResult'] = () => write.promise;
    h.window.zt[task ? 'taskDetail' : 'bugDetail'] = () => read.promise;
    vm.runInContext(`renderDetail = () => {}; renderBugDetail = () => {}; DT.open = true; DT.kind = '${kind}'; DT.id = 98`, h.context);
    h.context[open](task ? 'finish' : 'resolve', item);
    const submitting = h.context[confirm]();
    const reading = h.context[load](98);
    write.resolve({ ok: false, outcome: 'unknown', error: 'Synthetic lost reply' });
    await submitting;
    read.resolve({ ok: true, [kind]: { id: 98, writeStateKnown: true } });
    await reading;
    h.context[close]();
    h.context[open](task ? 'finish' : 'resolve', item);
    assert.equal(h.get(task ? 'tm-ok' : 'bm-ok').disabled, true);
    await h.context[confirm]();
    assert.equal((task ? h.writes : h.bugWrites).length, 1);
  }
});

test('connection identity changes invalidate old task and bug dialogs and detail intent', async () => {
  for (const kind of ['task', 'bug']) {
    const h = rendererHarness();
    vm.runInContext('renderAll = () => {}', h.context);
    h.context.apply({ config: { baseUrl: 'https://server-a.invalid', account: 'fixture-a', password: 'synthetic-a' }, state: { items: [] } });
    const task = kind === 'task';
    const open = task ? 'openTaskAction' : 'openBugAction';
    const confirm = task ? 'confirmTaskAction' : 'confirmBugAction';
    const write = deferred();
    h.window[task ? 'taskActionResult' : 'bugActionResult'] = () => write.promise;
    h.context[open](task ? 'finish' : 'resolve', { id: 99, name: 'Server A record', left: 1 });
    const submitting = h.context[confirm]();
    vm.runInContext(`DT.open = true; DT.kind = '${kind}'; DT.id = 99; DT.data = {id:99}`, h.context);
    h.context.apply({ config: { baseUrl: 'https://server-b.invalid', account: 'fixture-b', password: 'synthetic-b' }, state: { items: [] } });
    assert.equal(h.get(task ? 'task-modal' : 'bug-modal').hidden, true);
    assert.equal(h.get('detail').hidden, true);
    assert.equal(vm.runInContext('DT.open === false && DT.data === null && DT.id === 0', h.context), true);
    await h.context[confirm]();
    assert.equal((task ? h.writes : h.bugWrites).length, 1, 'old pending request is no longer an available intent');
    write.resolve({ ok: true, outcome: 'verified' });
    await submitting;
    assert.equal(h.detailReads.length, 0, 'old response cannot refresh the same numeric ID on the new server');
  }
});
