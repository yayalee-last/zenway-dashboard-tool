'use strict';

const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const output = process.env.ZT_WINDOW_TEST_DIR;
const root = path.resolve(__dirname, '../..');
app.setPath('userData', path.join(output, 'profile'));
const { createFloatingBall } = require('../../electron/floating-ball');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const items = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1, kind: 'task', name: 'Synthetic completed task ' + (index + 1),
  status: 'done', pri: 2, childrenState: 'supplied', children: [],
}));
const config = { baseUrl: 'https://example.invalid', account: 'fixture', displayMode: 'ball' };
const state = { ok: true, items, at: 0, needSetup: false };
const writes = [], requests = [], samples = [];
let panel, floating, cursor = { x: -10000, y: -10000 };
const report = value => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ...value, samples }, null, 2));

ipcMain.handle('state:get', () => ({ config, state, update: {} }));
ipcMain.handle('win:resize', (_event, height) => {
  const area = screen.getDisplayMatching(panel.getBounds()).workArea;
  const target = Math.max(200, Math.min(area.height - 80, Math.round(height)));
  if (Math.abs(target - panel.getSize()[1]) >= 4) panel.setBounds({ height: target });
});
ipcMain.on('win:task-dialog', (_event, open) => floating.setTaskDialogOpen(open));
ipcMain.handle('task:action', (_event, payload) => {
  writes.push(payload);
  return { ok: false, error: 'Synthetic permission failure' };
});

const js = source => panel.webContents.executeJavaScript(source);
async function until(predicate, description) {
  const deadline = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + description);
    await pause(25);
  }
}
function enterPanel() {
  const bounds = panel.getBounds();
  cursor = { x: bounds.x + 24, y: bounds.y + 24 };
}

app.whenReady().then(async () => {
  // This fixture never launches the application main process or its real clients.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(file|data):/.test(details.url);
    if (!allowed) requests.push(details.url);
    callback({ cancel: !allowed });
  });
  screen.getCursorScreenPoint = () => cursor;
  try {
    panel = new BrowserWindow({ width: 380, height: 520, show: false, frame: false,
      // Match the production panel so Windows outerHeight excludes resize borders.
      transparent: true, resizable: false,
      webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false } });
    await panel.loadFile(path.join(root, 'renderer/index.html'));
    await until(() => js('S.items.length === 10'), 'synthetic state');
    floating = createFloatingBall(panel, null, () => {});
    floating.setDisplayMode('ball');
    await until(() => floating.window.isVisible(), 'floating ball');
    const ballBounds = floating.window.getBounds();
    cursor = { x: ballBounds.x + 32, y: ballBounds.y + 32 };
    await until(() => panel.isVisible(), 'hover expansion');
    enterPanel();
    await js("document.querySelector('[data-filter=all]').click()");
    await pause(200);

    const before = panel.getBounds();
    assert.equal(await js('outerHeight'), before.height, 'fixture renderer and native window must use the same height');
    const target = await js(`(() => {
      const buttons = Array.from(document.querySelectorAll('.act.close'));
      const index = buttons.findIndex(button => {
        const rect = button.getBoundingClientRect();
        return rect.y + rect.height / 2 > 340 && rect.bottom < innerHeight - 24;
      });
      if (index < 0) return null;
      const rect = buttons[index].getBoundingClientRect();
      return { index, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    assert(target, 'fixture must click a visible close action below the old 320px dialog height');
    const content = panel.getContentBounds();
    cursor = { x: content.x + target.x, y: content.y + target.y };
    await pause(100);
    await js(`document.querySelectorAll('.act.close')[${target.index}].click()`);
    await pause(500); // Longer than the 80ms pointer tick plus 250ms collapse delay.
    samples.push({ before, after: panel.getBounds(), cursor, visible: panel.isVisible() });
    assert.equal(panel.isVisible(), true, 'opening close confirmation must not collapse under the original pointer');
    assert.equal(panel.getSize()[1], before.height, 'close confirmation must preserve a taller list viewport');
    assert.equal(await js("document.getElementById('task-modal').hidden"), false);
    assert.equal(writes.length, 0, 'opening the dialog must not write');

    // Background updates and pointer departures cannot dismiss an open task dialog.
    panel.webContents.send('state', state);
    panel.webContents.send('update', { hasUpdate: false });
    await pause(100);
    assert.equal(panel.getSize()[1], before.height);
    cursor = { x: -10000, y: -10000 };
    await pause(500);
    assert.equal(panel.isVisible(), true, 'mouse leave must keep an open task confirmation visible');
    assert.equal(await js("document.getElementById('task-modal').hidden"), false);
    await js("document.getElementById('tm-cancel').click()");
    await pause(100);
    assert.equal(panel.getSize()[1], before.height, 'cancel must restore normal list sizing');
    assert.equal(writes.length, 0);
    await until(() => !panel.isVisible(), 'mouse-leave collapse after cancellation');
    cursor = { x: ballBounds.x + 32, y: ballBounds.y + 32 };
    await until(() => panel.isVisible(), 'reopen after cancellation');
    enterPanel();

    // Page zoom changes CSS viewport pixels, not the native resize handler's DIP units.
    panel.webContents.setZoomFactor(1.25);
    await pause(100);
    const zoomBefore = panel.getBounds();
    const zoomSize = await js('({ inner: innerHeight, outer: outerHeight })');
    assert(zoomSize.inner < zoomSize.outer, 'fixture must exercise a zoomed CSS viewport');
    await js("openTaskAction('close', S.items[0])");
    await pause(100);
    assert.equal(panel.getSize()[1], zoomBefore.height, 'page zoom must not shrink the native confirmation window');
    await js("document.getElementById('task-modal').click()");
    panel.webContents.setZoomFactor(1);
    await pause(100);

    // A shorter page still grows enough to make both confirmation buttons usable.
    panel.webContents.send('state', { ...state, items: items.slice(0, 1) });
    await pause(150);
    assert(panel.getSize()[1] < 320, 'fixture must exercise a compact list');
    await js("document.querySelector('.act.close').click()");
    await pause(100);
    assert(panel.getSize()[1] >= 320, 'compact list must grow to the confirmation minimum');
    assert.equal(await js(`(() => {
      const rect = document.getElementById('tm-ok').getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    })()`), true, 'confirmation button must be on screen');
    await js("document.getElementById('tm-ok').click()");
    await until(() => writes.length === 1, 'explicit confirmation');
    assert.deepEqual(writes[0], { id: 1, action: 'close', payload: { closedReason: 'done' } });
    assert.equal(await js("document.getElementById('tm-err').textContent"), 'Synthetic permission failure');
    assert.equal(await js("document.getElementById('task-modal').hidden"), false);
    cursor = { x: -10000, y: -10000 };
    await pause(500);
    assert.equal(panel.isVisible(), true, 'a failed submission must keep the task dialog visible');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await pause(100);
    assert.equal(await js("document.getElementById('task-modal').hidden"), true);
    assert(panel.getSize()[1] < 320, 'Escape must restore compact list sizing');
    await until(() => !panel.isVisible(), 'mouse-leave collapse after Escape');
    assert.deepEqual(requests, [], 'fixture must not attempt real network requests');

    // Native shutdown may close the ball before application-level cleanup runs.
    floating.window.destroy();
    await pause(350);
    assert.equal(panel.isDestroyed(), false, 'closing the ball must not destroy the main panel');
    floating.destroy();
    report({ passed: true });
  } catch (error) {
    report({ passed: false, error: error.stack,
      panel: panel && { bounds: panel.getBounds(), visible: panel.isVisible() },
      ball: floating && !floating.window.isDestroyed() && { bounds: floating.window.getBounds(), visible: floating.window.isVisible() },
      cursor, point: screen.getCursorScreenPoint(), display: screen.getPrimaryDisplay().workArea });
    process.exitCode = 1;
  } finally {
    floating?.destroy();
    panel?.destroy();
    app.exit(process.exitCode || 0);
  }
});
