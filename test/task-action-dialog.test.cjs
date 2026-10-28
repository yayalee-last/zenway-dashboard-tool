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
  const dialogStates = [];
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
      setTaskDialogOpen(open) { dialogStates.push(open); },
      taskAction(payload) { writes.push(payload); return Promise.resolve({ ok: true }); },
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
  return { context, get, listeners, resizeCalls, writes, window, dialogStates };
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
    h => h.get('tm-close').listeners.click(),
    h => h.listeners.get('keydown')({ key: 'Escape' }),
    h => h.get('task-modal').listeners.click({ target: h.get('task-modal') }),
  ]) {
    const h = rendererHarness({ innerHeight: 675, listHeight: 675 });
    h.context.openTaskAction('close', { id: 9, name: 'Completed fixture task', status: 'done' });
    dismiss(h);
    assert.equal(h.get('task-modal').hidden, true);
    assert.equal(h.writes.length, 0);
    assert.equal(h.resizeCalls.at(-1), 675);
    assert.deepEqual(h.dialogStates, [true, false]);
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
  await h.context.confirmTaskAction();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes[0])), { id: 9, action: 'close', payload: { closedReason: 'done' } });

  const detail = rendererHarness({ innerHeight: 600, listHeight: 675, detailOpen: true });
  detail.context.openTaskAction('close', item);
  assert.deepEqual(detail.resizeCalls, [600], 'opening from details must retain the current detail height');
  detail.get('tm-cancel').listeners.click();
  assert.equal(detail.resizeCalls.at(-1), 600);
});

test('start, finish, and close hold the panel until the task dialog is dismissed', () => {
  for (const action of ['start', 'finish', 'close']) {
    const h = rendererHarness();
    h.context.openTaskAction(action, { id: 7, name: 'Synthetic task', left: 2 });
    assert.deepEqual(h.dialogStates, [true]);
    h.context.closeTaskAction();
    assert.deepEqual(h.dialogStates, [true, false]);
    assert.equal(h.writes.length, 0);
  }
});

test('failed submissions keep the dialog held and success releases it', async () => {
  const h = rendererHarness();
  h.window.zt.taskAction = async () => ({ ok: false, error: 'Synthetic failure' });
  h.context.openTaskAction('finish', { id: 7, name: 'Synthetic task', left: 2 });
  await h.context.confirmTaskAction();
  assert.equal(h.get('task-modal').hidden, false);
  assert.equal(h.get('tm-err').textContent, 'Synthetic failure');
  assert.deepEqual(h.dialogStates, [true]);
  h.window.zt.taskAction = async () => ({ ok: true, status: 'done' });
  await h.context.confirmTaskAction();
  assert.equal(h.get('task-modal').hidden, true);
  assert.deepEqual(h.dialogStates, [true, false]);
});

test('start feedback reflects the verified final status', async () => {
  for (const [status, message] of [['done', '已完成'], ['doing', '已开始']]) {
    const h = rendererHarness();
    h.window.zt.taskAction = async () => ({ ok: true, status });
    h.context.openTaskAction('start', { id: 7, name: 'Synthetic task', left: 0 });
    await h.context.confirmTaskAction();
    assert(h.get('toast').textContent.includes(message));
    assert.equal(h.get('task-modal').hidden, true);
    assert.deepEqual(h.dialogStates, [true, false]);
  }
});
