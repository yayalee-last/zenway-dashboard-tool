'use strict';

const { app, BrowserWindow, ipcMain, screen, session, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { wireImagePreview } = require('../../electron/image-preview');

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
async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + label + ' ' + JSON.stringify(BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), visible: w.isVisible(), loading: w.webContents.isLoading(), url: w.webContents.getURL() }))));
    await pause(20);
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false } });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/.test(details.url) }));
  wireImagePreview({ BrowserWindow, ipcMain, screen, getPanel: () => win,
    isMainSender: event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame });
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
    await checkImagePreview(win);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true }));
    app.quit();
  } catch (error) {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack }));
    if (!win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});

async function checkImagePreview(win) {
  const bitmap = Buffer.alloc(1200 * 800 * 4, 0xff);
  const src = nativeImage.createFromBitmap(bitmap, { width: 1200, height: 800 }).toDataURL();
  const evaluate = code => win.webContents.executeJavaScript(code);
  const preview = () => BrowserWindow.getAllWindows().find(window => window.getTitle() === '图片预览');
  for (const kind of ['task', 'bug']) {
    await evaluate(`openDetail({ kind: '${kind}', id: ${kind === 'task' ? 119 : 49} })`);
    await evaluate(`(() => {
      const desc = document.createElement('div');
      desc.innerHTML = '<a href="https://example.invalid/must-not-open"><img data-orig="https://example.invalid/original"></a>';
      desc.querySelector('img').src = ${JSON.stringify(src)};
      document.getElementById('dt-body').append(desc);
      fixImages(desc);
    })()`);
    await until(() => evaluate("document.querySelector('#dt-body img')?.naturalWidth === 1200"), 'inline image');
    await evaluate("document.querySelector('#dt-body img').click()");
    await until(() => preview()?.isVisible(), 'preview window');
    const viewer = preview();
    const inspect = code => viewer.webContents.executeJavaScript(code);
    await until(() => inspect("!document.getElementById('image').hidden"), 'preview image');
    assert.equal(await inspect("document.getElementById('image').src"), src);
    assert.equal(await inspect("typeof window.zt"), 'undefined');
    assert.equal(await inspect("typeof require"), 'undefined');
    assert.equal(viewer.webContents.getLastWebPreferences().sandbox, true);
    const before = await inspect('scale');
    assert(before < 1);
    await inspect("document.getElementById('zoom-in').click()");
    assert(await inspect('scale') > before);
    await inspect("document.getElementById('actual').click()");
    assert.equal(await inspect('scale'), 1);
    assert.equal(await inspect("document.getElementById('image').offsetWidth"), 1200);
    await inspect("document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))");
    assert(await inspect('scale') > 1);
    await inspect("document.getElementById('fit').click()");
    assert(await inspect('scale') < 1);
    if (kind === 'task') fs.writeFileSync(path.join(output, 'image-preview.png'), (await viewer.webContents.capturePage()).toPNG());
    viewer.maximize();
    await until(() => viewer.isMaximized(), 'maximize');
    await inspect("document.getElementById('fit').click()");
    assert(await inspect("document.getElementById('image').offsetWidth <= document.getElementById('viewport').clientWidth"));
    assert(await inspect("document.getElementById('image').offsetHeight <= document.getElementById('viewport').clientHeight"));
    await evaluate("document.querySelector('#dt-body img').click(); document.querySelector('#dt-body img').click()");
    assert.equal(preview(), viewer);
    await until(() => inspect("!document.getElementById('image').hidden"), 'repeated image loaded');
    assert.equal(BrowserWindow.getAllWindows().filter(window => window.getTitle() === '图片预览').length, 1);
    win.hide();
    assert.equal(viewer.isVisible(), true);
    await evaluate("window.zt.previewImage('https://example.invalid/missing.png')");
    await until(() => inspect("!document.getElementById('status').hidden && document.getElementById('status').textContent.includes('加载失败')"), 'failed image message');
    await evaluate(`window.zt.previewImage(${JSON.stringify(src)})`);
    await until(() => inspect("!document.getElementById('image').hidden"), 'replace failed image');
    const stateBefore = await evaluate('JSON.stringify(DT)');
    if (kind === 'task') {
      await inspect("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    } else {
      await inspect("document.getElementById('close').click()");
    }
    await until(() => !preview(), 'close preview');
    assert.equal(await evaluate('JSON.stringify(DT)'), stateBefore);
  }
  for (const src of [null, {}, 'file:///C:/private.png', 'javascript:alert(1)', 'data:text/html;base64,AAAA', 'https://user:password@example.invalid/image']) {
    assert.equal((await evaluate(`window.zt.previewImage(${JSON.stringify(src)})`)).ok, false);
    assert.equal(preview(), undefined);
  }
  const untrusted = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false } });
  await untrusted.loadFile(path.join(root, 'renderer/index.html'));
  assert.equal((await untrusted.webContents.executeJavaScript(`window.zt.previewImage(${JSON.stringify(src)})`)).ok, false);
  untrusted.destroy();
  await evaluate(`window.zt.previewImage(${JSON.stringify(src)})`);
  await until(() => preview()?.isVisible(), 'reopen preview');
  const viewer = preview();
  win.destroy();
  assert.equal(viewer.isDestroyed(), true);
}
