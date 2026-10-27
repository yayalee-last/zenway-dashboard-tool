'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const output = process.env.ZT_ATTACHMENT_TEST_DIR;
app.setPath('userData', path.join(output, 'profile'));
const root = path.resolve(__dirname, '../..');
const pending = [], calls = [];
const file = { id: 180, name: '<附件>.txt' };
ipcMain.handle('state:get', () => ({ state: { ok: true, items: [], at: 0 }, config: { baseUrl: 'https://example.invalid' }, update: {} }));
ipcMain.handle('win:resize', () => {});
ipcMain.handle('task:detail', () => ({ ok: true, task: { id: 119, name: 'Task', status: 'doing', files: [file] } }));
ipcMain.handle('bug:detail', () => ({ ok: true, bug: { id: 49, title: 'Bug', status: 'active', files: [file] } }));
ipcMain.handle('attachment:open', (_event, payload) => {
  calls.push(payload);
  return new Promise((resolve, reject) => pending.push({ resolve, reject }));
});
ipcMain.handle('open:external', () => { assert.fail('attachment click must not open the browser'); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadFile(path.join(root, 'renderer/index.html'));
    for (const [kind, id] of [['task', 119], ['bug', 49]]) {
      await win.webContents.executeJavaScript(`openDetail({ kind: '${kind}', id: ${id} })`);
      assert.equal(await win.webContents.executeJavaScript("document.querySelector('.dt-file .sname').textContent"), file.name);
      assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.dt-file').length"), 1);
      await win.webContents.executeJavaScript("document.querySelector('.dt-file').click()");
      await pause(50);
      assert.deepEqual(calls.at(-1), { kind, id, fileId: 180 });
      assert.equal(await win.webContents.executeJavaScript("document.querySelector('.dt-file').disabled"), true);
      pending.shift().resolve({ ok: false, error: '无权限下载此附件' });
      await pause(50);
      assert.equal(await win.webContents.executeJavaScript("document.querySelector('.dt-file-error').hidden"), false);
      assert.equal(await win.webContents.executeJavaScript("document.querySelector('.dt-file-error').textContent"), '无权限下载此附件');
      assert.equal(await win.webContents.executeJavaScript("document.querySelector('.dt-file').disabled"), false);
      await win.webContents.executeJavaScript("document.querySelector('.dt-file').click()");
      await pause(50);
      pending.shift().resolve({ ok: true });
      await pause(50);
      assert.equal(await win.webContents.executeJavaScript("document.querySelector('.dt-file-error').hidden"), true);
      await win.webContents.executeJavaScript("document.querySelector('.dt-file').click()");
      await pause(50);
      pending.shift().reject(new Error('IPC test failure'));
      await pause(50);
      assert.equal(await win.webContents.executeJavaScript("document.querySelector('.dt-file-error').textContent"), '附件打开失败，请重试');
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true }));
    win.destroy();
    app.quit();
  } catch (error) {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack }));
    win.destroy();
    app.exit(1);
  }
});
