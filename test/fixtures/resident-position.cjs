'use strict';

const { app, ipcMain, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const output = process.env.ZT_WINDOW_TEST_DIR;
const root = path.resolve(__dirname, '../..');
const profile = path.join(output, 'user-data');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  baseUrl: 'https://example.invalid', account: 'position-test', autoUpdate: false,
  displayMode: 'panel', alwaysOnTop: true,
}));
process.argv.push('--mock');

const source = path.join(root, 'electron/main.js');
const main = new Module(source, module);
main.filename = source;
main.paths = Module._nodeModulePaths(path.dirname(source));
main._compile(fs.readFileSync(source, 'utf8') +
  '\nmodule.exports = { getWindow: () => win, getFloatingBall: () => floatingBall, doRefresh, showAndFocus };', source);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const samples = [];
const report = value => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(value, null, 2));

app.whenReady().then(async () => {
  let cursor = { x: -100000, y: -100000 };
  screen.getCursorScreenPoint = () => cursor;
  try {
    const until = Date.now() + 5000;
    while (!main.exports.getFloatingBall() || !main.exports.getWindow().isVisible()) {
      if (Date.now() > until) throw new Error('Resident panel did not become ready');
      await pause(30);
    }
    const win = main.exports.getWindow();
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    for (const kind of ['task', 'bug']) {
      ipcMain.removeHandler(kind + ':detail');
      ipcMain.handle(kind + ':detail', (_event, id) => ({
        ok: true,
        [kind]: { id, name: 'Position regression', title: 'Position regression',
          status: kind === 'bug' ? 'active' : 'doing', desc: '<p>Task</p>', steps: '<p>Bug</p>' },
      }));
    }
    await main.exports.doRefresh('position-test');
    await pause(150);
    const dragged = [area.x + 80, area.y + 40];
    win.setPosition(...dragged);
    await pause(50);
    const checkPosition = (label, expected) => {
      const actual = win.getPosition();
      samples.push({ label, expected, actual, bounds: win.getBounds() });
      assert.deepEqual(actual, expected, label);
    };

    for (const kind of ['task', 'bug']) {
      await win.webContents.executeJavaScript("openDetail({ id: 42, kind: '" + kind + "' })");
      await pause(100);
      checkPosition(kind + ' detail must preserve the dragged position', dragged);
      await win.webContents.executeJavaScript('openSettings()');
      await pause(100);
      checkPosition('settings must preserve the dragged position', dragged);
      await win.webContents.executeJavaScript('closeSettings(); closeDetail()');
      await pause(100);
      checkPosition('returning to the list must preserve the dragged position', dragged);
    }
    await main.exports.doRefresh('position-test');
    await pause(100);
    checkPosition('refresh must preserve the dragged position', dragged);
    win.hide();
    main.exports.showAndFocus();
    checkPosition('restoring a resident panel must preserve its position', dragged);

    await win.webContents.executeJavaScript('window.zt.resize(300)');
    await pause(100);
    const edge = [area.x + 100, area.y + area.height - 340];
    win.setPosition(...edge);
    await win.webContents.executeJavaScript("openDetail({ id: 42, kind: 'task' })");
    await pause(100);
    checkPosition('growing near the bottom must only correct the overflow',
      [edge[0], Math.min(edge[1], area.y + area.height - win.getSize()[1])]);

    const ball = main.exports.getFloatingBall().window;
    const anchor = ball.getBounds();
    cursor = { x: anchor.x + 32, y: anchor.y + 32 };
    await win.webContents.executeJavaScript("window.zt.saveConfig({displayMode:'ball'})");
    main.exports.showAndFocus();
    await pause(100);
    assert.equal(win.getBounds().x + win.getBounds().width, ball.getBounds().x,
      'ball mode must continue docking the panel beside the ball');

    report({ passed: true, samples });
    app.__quitting = true;
    app.quit();
  } catch (error) {
    report({ passed: false, error: error.stack, samples });
    app.__quitting = true;
    app.exit(1);
  }
});