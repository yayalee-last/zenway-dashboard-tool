'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const output = process.env.ZT_WINDOW_TEST_DIR;
const root = path.resolve(__dirname, '../..');
const profile = path.join(output, 'user-data');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
let win;
let failNext = false;
const writes = [];
const saved = [];
let config = { baseUrl: 'https://example.invalid', account: 'list-test', alwaysOnTop: true, sortMode: 'priority' };
const items = [
  { id: 1, kind: 'task', name: '客户端开发', status: 'doing', pri: 1, left: 8 },
  { id: 2, kind: 'task', name: '【特权】程序', status: 'done', pri: 3 },
  { id: 3, kind: 'task', name: '跨服联赛界面美化优化', status: 'wait', pri: 2, deadline: '2000-01-01' },
  { id: 4, kind: 'task', name: '已关闭的任务', status: 'closed', pri: 4 },
  { id: 5, kind: 'task', name: '已取消的任务', status: 'cancel', pri: 4 },
];
const state = () => ({ ok: true, items, at: Date.now(), needSetup: false });
const boot = () => ({ config, state: state(), update: { current: 'test', hasUpdate: false } });
ipcMain.handle('state:get', boot);
ipcMain.handle('zentao:refresh', boot);
ipcMain.handle('win:resize', (_event, height) => win.setBounds({ height: Math.max(240, Math.min(700, height)) }));
ipcMain.handle('config:save', (_event, patch) => {
  saved.push(patch);
  config = { ...config, ...patch };
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify(config));
  return boot();
});
ipcMain.handle('task:detail', (_event, id) => ({ ok: true, task: {
  ...items.find(item => item.id === id), desc: '<p>隔离界面检查</p>',
  assignedRealname: config.account, isMine: true, readOnly: false,
  childrenState: 'supplied', children: [],
} }));
ipcMain.handle('task:action', (_event, action) => {
  writes.push(action);
  assert.equal(action.action, 'close');
  assert.deepEqual(action.payload, { closedReason: 'done' });
  const task = items.find(item => item.id === action.id);
  assert.equal(task.status, 'done');
  if (failNext) {
    failNext = false;
    return { ok: false, outcome: 'rejected', error: '没有关闭任务的权限（测试）' };
  }
  task.status = 'closed';
  win.webContents.send('state', state());
  return { ok: true, state: state(), status: 'closed' };
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = script => win.webContents.executeJavaScript(script);
async function until(script) {
  const deadline = Date.now() + 3000;
  while (!(await js(script))) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + script);
    await pause(25);
  }
}
async function allItems() {
  await until("S.items.length === 5");
  await js("document.querySelector('[data-filter=all]').click()");
}
const order = () => js("visibleItems().map(item => item.id)");
const closeRow = () => js("document.querySelector('.item[data-status=done] .act.close').click()");

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 380, height: 600, frame: false, transparent: true, show: false,
      webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(root, 'renderer/index.html'));
    await until("S.items.length === 5");
    assert.equal(await js("getComputedStyle(document.querySelector('.list-sort')).display"), 'none', 'default unfinished tab must hide sorting');
    const compactTabsHeight = await js("document.getElementById('tabs').getBoundingClientRect().height");
    await allItems();
    assert.notEqual(await js("getComputedStyle(document.querySelector('.list-sort')).display"), 'none', 'all tab must show sorting');
    assert(await js("document.getElementById('tabs').getBoundingClientRect().height") > compactTabsHeight);
    assert.deepEqual(await order(), [1, 3, 2, 4, 5]);
    assert.equal(await js("document.querySelectorAll('.item .act.close').length"), 1);
    await js("document.getElementById('sort-mode').value = 'completed'; document.getElementById('sort-mode').dispatchEvent(new Event('change', {bubbles:true}))");
    await until("document.getElementById('sort-mode').value === 'completed' && visibleItems()[0].id === 2");
    assert.equal(saved[0].sortMode, 'completed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).sortMode, 'completed');
    assert.deepEqual(await order(), [2, 1, 3, 4, 5]);
    for (const filter of ['open', 'bug', 'overdue']) {
      await js(`document.querySelector('[data-filter=${filter}]').click()`);
      assert.equal(await js("getComputedStyle(document.querySelector('.list-sort')).display"), 'none', filter + ' must hide sorting');
      assert.equal(await js("document.querySelector('.list-sort').getBoundingClientRect().height"), 0);
      assert.equal(await js("document.getElementById('tabs').getBoundingClientRect().height"), compactTabsHeight, 'hidden sorting must not leave a blank row');
    }
    await allItems();
    assert.notEqual(await js("getComputedStyle(document.querySelector('.list-sort')).display"), 'none');
    assert.equal(await js("document.getElementById('sort-mode').value"), 'completed');
    assert.equal((await order())[0], 2);

    await win.loadFile(path.join(root, 'renderer/index.html'));
    await allItems();
    assert.equal(await js("document.querySelector('.tab.active').dataset.filter"), 'all');
    assert.equal(await js("document.getElementById('sort-mode').value"), 'completed');
    assert.equal((await order())[0], 2);
    await js("document.querySelector('.item[data-status=done] .act.close').focus()");
    assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);

    await closeRow();
    assert.equal(await js("document.getElementById('tm-title').textContent"), '关闭任务');
    assert.equal(await js("getComputedStyle(document.getElementById('tm-hours')).display"), 'none');
    assert.equal(await js("document.getElementById('tm-close-note').hidden"), false);
    assert.equal(await js('DT.open'), false, 'action must not also open task details');
    assert.equal(await js("document.getElementById('tm-ok').getBoundingClientRect().bottom <= innerHeight"), true);
    await js("document.getElementById('tm-cancel').click()");
    assert.equal(writes.length, 0, 'cancel must not write');

    failNext = true;
    await closeRow();
    await js("document.getElementById('tm-ok').click()");
    await until("!document.getElementById('tm-err').hidden");
    assert.match(await js("document.getElementById('tm-err').textContent"), /权限/);
    assert.equal(await js("document.getElementById('task-modal').hidden"), false);
    assert.equal(items[1].status, 'done');
    await js("document.getElementById('tm-ok').click()");
    await until("document.getElementById('task-modal').hidden && S.items.find(item => item.id === 2).status === 'closed'");
    assert.equal(await js("document.querySelectorAll('.item[data-status=closed] .act.close').length"), 0);
    assert.equal(await js("document.getElementById('toast').textContent"), '任务已关闭');

    items[1].status = 'done';
    win.webContents.send('state', state());
    await js("openDetail({id:2,kind:'task'})");
    assert.equal(await js("document.querySelector('#dt-foot .primary').textContent"), '关闭任务');
    await js("document.querySelector('#dt-foot .primary').click(); document.getElementById('tm-ok').click()");
    await until("document.getElementById('task-modal').hidden && DT.data.status === 'closed'");
    assert.equal(await js("document.querySelector('#dt-foot .primary') === null"), true);
    await js('closeDetail()');

    for (const action of ['start', 'finish']) {
      await js(`document.querySelector('.act.${action}').click()`);
      assert.notEqual(await js("getComputedStyle(document.getElementById('tm-hours')).display"), 'none');
      assert.equal(await js("document.getElementById('tm-close-note').hidden"), true);
      await js('closeTaskAction()');
    }
    assert.equal(writes.length, 3);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, writes, saved }, null, 2));
    app.quit();
  } catch (error) {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack, writes, saved }, null, 2));
    app.exit(1);
  }
});
