'use strict';

const { app, BrowserWindow } = require('electron');
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
  baseUrl: 'https://example.invalid', account: 'window-test', intervalSec: 30,
  alwaysOnTop: true, autoLaunch: false, autoUpdate: false,
}));
process.argv.push('--mock');

// Run the real main process against an isolated profile, without adding a test API to production.
const source = path.join(root, 'electron/main.js');
const main = new Module(source, module);
main.filename = source;
main.paths = Module._nodeModulePaths(path.dirname(source));
main._compile(fs.readFileSync(source, 'utf8') + `
module.exports = { getWindow: () => win, getState: () => state, toggleWindow, showAndFocus, doRefresh, buildTrayMenu };
`, source);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const samples = [];
const report = value => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(value, null, 2));

app.whenReady().then(async () => {
  let peer;
  const win = main.exports.getWindow();
  const snapshot = label => samples.push({ label, visible: win.isVisible(), pinned: win.isAlwaysOnTop(), bounds: win.getBounds() });
  try {
    const deadline = Date.now() + 10000;
    while (!win.isVisible() || win.webContents.isLoading()) {
      if (Date.now() > deadline) throw new Error('Window did not become ready');
      await pause(50);
    }
    await pause(600);
    win.setTitle('禅道挂件 · 修复验证');
    assert.equal(win.isAlwaysOnTop(), true, 'startup must apply the requested pin');
    snapshot('startup');

    // Reproduce a lost native pin while the saved preference is still enabled.
    win.setAlwaysOnTop(false);
    assert.equal(win.isAlwaysOnTop(), false);
    win.emit('blur');
    assert.equal(win.isAlwaysOnTop(), true, 'blur must recover a lost pin');
    snapshot('lost-pin-recovered');

    peer = new BrowserWindow({ width: 520, height: 400, show: false });
    await peer.loadURL('data:text/html,<body>Window switching test</body>');
    peer.show();
    await pause(150);
    assert.equal(win.isAlwaysOnTop(), true, 'another normal window must not clear pin');
    assert.equal(win.isVisible(), true);
    peer.destroy();
    peer = null;
    snapshot('after-window-switch');

    const togglePin = () => win.webContents.executeJavaScript('window.zt.togglePin()');
    await togglePin();
    win.emit('blur');
    assert.equal(win.isAlwaysOnTop(), false, 'disabled pin must stay disabled on blur');
    await togglePin();
    assert.equal(win.isAlwaysOnTop(), true);

    const menuItem = main.exports.buildTrayMenu().items.find(item => item.label === '窗口置顶');
    menuItem.click(menuItem);
    assert.equal(win.isAlwaysOnTop(), false, 'tray pin switch must apply');
    await win.webContents.executeJavaScript('window.zt.saveConfig({alwaysOnTop:true})');
    assert.equal(win.isAlwaysOnTop(), true, 'settings pin switch must apply');

    await win.webContents.executeJavaScript('window.zt.minimize()');
    await main.exports.doRefresh('timer');
    assert.equal(win.isVisible(), false, 'refresh must not undo intentional hiding');
    main.exports.toggleWindow();
    assert.equal(win.isVisible(), true);
    assert.equal(win.isAlwaysOnTop(), true, 'tray restore must reapply pin');
    win.hide();
    win.setAlwaysOnTop(false);
    main.exports.showAndFocus();
    assert.equal(win.isVisible(), true);
    assert.equal(win.isAlwaysOnTop(), true, 'second instance/settings restore must reapply pin');
    snapshot('after-tray-restore');

    const refreshedAt = main.exports.getState().at;
    await pause(31000);
    assert(main.exports.getState().at > refreshedAt, 'scheduled refresh must have run');
    assert.equal(win.isVisible(), true, 'idle refresh must keep the window visible');
    assert.equal(win.isAlwaysOnTop(), true, 'idle refresh must keep the window pinned');
    const text = await win.webContents.executeJavaScript('document.body.innerText');
    assert(text.includes('禅道'));
    fs.writeFileSync(path.join(output, 'idle.png'), (await win.capturePage()).toPNG());
    snapshot('after-idle-refresh');
    report({ passed: true, samples });
    app.__quitting = true;
    app.quit();
  } catch (error) {
    report({ passed: false, error: error.stack, samples });
    if (peer && !peer.isDestroyed()) peer.destroy();
    app.__quitting = true;
    app.exit(1);
  }
});