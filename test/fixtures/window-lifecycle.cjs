'use strict';

const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const output = process.env.ZT_WINDOW_TEST_DIR;
const root = path.resolve(__dirname, '../..');
const profile = path.join(output, 'user-data');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setLoginItemSettings = () => {}; // Keep the settings test isolated from Windows startup preferences.
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  baseUrl: 'https://example.invalid', account: 'window-test', intervalSec: 30,
  alwaysOnTop: true, autoLaunch: false, autoUpdate: false,
  displayMode: 'ball',
}));
process.argv.push('--mock');
const readyWindows = new WeakSet();
app.on('browser-window-created', (_event, window) => {
  window.once('ready-to-show', () => readyWindows.add(window));
});

// Run the real main process against an isolated profile, without adding a test API to production.
const source = path.join(root, 'electron/main.js');
const main = new Module(source, module);
main.filename = source;
main.paths = Module._nodeModulePaths(path.dirname(source));
main._compile(fs.readFileSync(source, 'utf8') + `
module.exports = { getWindow: () => win, getFloatingBall: () => floatingBall, getState: () => state, toggleWindow, showAndFocus, doRefresh, buildTrayMenu, pushState, loadConfig, createWindow };
`, source);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const samples = [];
const report = value => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(value, null, 2));

app.whenReady().then(async () => {
  let peer;
  const win = main.exports.getWindow();
  const outside = { x: -100000, y: -100000 };
  let cursor = outside;
  screen.getCursorScreenPoint = () => cursor;
  const snapshot = label => samples.push({ label, visible: win.isVisible(), pinned: win.isAlwaysOnTop(), bounds: win.getBounds() });
  try {
    const deadline = Date.now() + 10000;
    while (!main.exports.getFloatingBall()?.window.isVisible() || win.webContents.isLoading()) {
      if (Date.now() > deadline) throw new Error('Window did not become ready');
      await pause(50);
    }
    const ball = main.exports.getFloatingBall().window;
    const originalBall = ball.getBounds();
    const enterBall = () => {
      const bounds = ball.getBounds();
      cursor = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    };
    const enterPanel = () => {
      const bounds = win.getBounds();
      cursor = { x: bounds.x + 24, y: bounds.y + 24 };
    };
    assert.equal(win.isVisible(), false, 'startup must show only the floating ball');
    assert.equal(ball.isAlwaysOnTop(), true);
    assert.equal(ball.isFocusable(), false, 'the ball must not steal focus');
    enterBall();
    await pause(200);
    assert.equal(win.isVisible(), true, 'hovering the ball must open the panel');
    assert.equal(win.isFocused(), false, 'hover must not steal keyboard focus');
    const hoverHeight = win.getSize()[1];
    fs.writeFileSync(path.join(output, 'ball.png'), (await ball.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'hover-panel.png'), (await win.capturePage()).toPNG());
    enterPanel();
    await pause(400);
    assert.equal(win.isVisible(), true, 'moving from the ball into the panel must keep it open');
    cursor = outside;
    await pause(160);
    assert.equal(win.isVisible(), true, 'a brief departure must allow crossing the gap');
    enterPanel();
    await pause(400);
    assert.equal(win.isVisible(), true, 're-entering must cancel pending collapse');
    cursor = outside;
    await pause(450);
    assert.equal(win.isVisible(), false, 'leaving both regions must collapse the panel');
    assert.equal(ball.isVisible(), true, 'collapse must leave the floating ball visible');
    await main.exports.doRefresh('timer');
    assert.equal(win.isVisible(), false, 'background refresh must not expand the panel');
    enterBall();
    await pause(200);
    assert.equal(win.getSize()[1], hoverHeight, 'reopening must preserve the panel height');

    const area = screen.getDisplayMatching(originalBall).workArea;
    ball.setPosition(area.x, area.y);
    enterBall();
    await pause(200);
    assert.equal(win.getBounds().x, ball.getBounds().x + ball.getBounds().width, 'left-edge ball must open the panel beside its right edge');
    ball.setPosition(area.x + area.width - originalBall.width, area.y + area.height - originalBall.height);
    enterBall();
    await pause(200);
    await win.webContents.executeJavaScript('window.zt.resize(660)');
    await pause(400);
    const edgeBounds = win.getBounds();
    assert(edgeBounds.x >= area.x && edgeBounds.x + edgeBounds.width <= area.x + area.width);
    assert(edgeBounds.y >= area.y && edgeBounds.y + edgeBounds.height <= area.y + area.height, 'resizing near the bottom must keep the panel on screen');
    const savedPosition = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).ballPosition;
    assert.deepEqual(savedPosition, { x: ball.getBounds().x, y: ball.getBounds().y }, 'dragged ball position must be saved');
    ball.setPosition(originalBall.x, originalBall.y);
    enterBall();
    await win.webContents.executeJavaScript(`window.zt.resize(${hoverHeight})`);
    await pause(200);
    enterPanel();
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

    const sendRelease = async (version, hasUpdate = true) => {
      win.webContents.send('update', { current: '0.3.4', latest: version, hasUpdate });
      await pause(50);
    };
    const barHidden = () => win.webContents.executeJavaScript("document.getElementById('update-bar').hidden");
    await sendRelease('v0.3.5');
    assert.equal(await barHidden(), false, 'detected release must show the bottom bar');
    await win.webContents.executeJavaScript("document.getElementById('ub-close').click()");
    await sendRelease('v0.3.5');
    assert.equal(await barHidden(), true, 'same release must respect dismissal');
    await sendRelease('v0.3.6');
    assert.equal(await barHidden(), false, 'a newer release must become visible again');
    await sendRelease('v0.3.6', false);
    // Update notifications must size the visible page, even when the list is hidden.
    const listHeight = win.getSize()[1];
    const { ipcMain } = require('electron');
    ipcMain.removeHandler('task:detail');
    ipcMain.handle('task:detail', async (_event, id) => ({
      ok: true, task: { id, name: 'Detail height regression', status: 'doing', desc: '<p>Task description</p>' },
    }));
    for (const kind of ['task', 'bug']) {
      await win.webContents.executeJavaScript(`openDetail({ id: 1042, kind: '${kind}' })`);
      await pause(100);
      const detailHeight = win.getSize()[1];
      assert.equal(detailHeight, 600, `${kind} detail must open at its intended height`);
      cursor = outside;
      await pause(450);
      assert.equal(win.isVisible(), false, 'detail must collapse on mouse leave');
      enterBall();
      await pause(200);
      assert.equal(win.isVisible(), true);
      assert.equal(win.getSize()[1], detailHeight, 'hovering again must restore detail height');
      assert.equal(await win.webContents.executeJavaScript("document.getElementById('detail').hidden"), false, 'collapse must preserve the current detail');
      enterPanel();
      await sendRelease('v0.3.6', false);
      assert.equal(win.getSize()[1], detailHeight, `update check must preserve ${kind} detail height`);
      await sendRelease('v0.3.7');
      assert.equal(win.getSize()[1], detailHeight, 'visible update bar must preserve detail height');
      await win.webContents.executeJavaScript("document.getElementById('ub-close').click()");
      await pause(100);
      assert.equal(win.getSize()[1], detailHeight, 'dismissing an update must preserve detail height');

      await win.webContents.executeJavaScript("document.getElementById('btn-settings-link').click()");
      await pause(100);
      const settingsHeight = win.getSize()[1];
      await sendRelease('v0.3.7', false);
      assert.equal(win.getSize()[1], settingsHeight, 'update check must preserve settings height');
      await win.webContents.executeJavaScript("document.getElementById('btn-close-modal').click()");
      await pause(100);
      assert.equal(win.getSize()[1], detailHeight, 'closing settings must restore detail height');

      if (kind === 'bug') {
        await win.webContents.executeJavaScript("document.querySelector('#dt-foot .btn.primary').click()");
        await pause(100);
        const actionHeight = win.getSize()[1];
        await sendRelease('v0.3.7', false);
        assert.equal(win.getSize()[1], actionHeight, 'update check must preserve bug action height');
        await win.webContents.executeJavaScript("document.getElementById('bm-cancel').click()");
        await pause(100);
        assert.equal(win.getSize()[1], detailHeight, 'closing bug action must restore detail height');
      }

      await win.webContents.executeJavaScript("document.getElementById('dt-back').click()");
      await pause(100);
      assert.equal(win.getSize()[1], listHeight, 'returning to the list must restore content sizing');
    }

    // Exercise settings, native preview placement and live state against the real windows.
    const artifacts = process.env.ZT_PREVIEW_ARTIFACT_DIR || output;
    const waitUntil = async (predicate) => {
      const until = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > until) throw new Error('Preview did not reach the expected state');
        await pause(40);
      }
    };
    const previewWindow = () => BrowserWindow.getAllWindows().find(window => window.getTitle() === '禅道常驻待办');
    const previewIds = preview => preview.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('li'), row => Number(row.dataset.id))");
    assert.equal(previewWindow(), undefined, 'preview must be off by default');
    await win.webContents.executeJavaScript("openSettings()");
    assert.equal(await win.webContents.executeJavaScript("document.getElementById('f-showTopThree').checked"), false);
    await win.webContents.executeJavaScript(
      "document.getElementById('f-showTopThree').checked = true; document.getElementById('f-previewSide').value = 'left'");
    fs.writeFileSync(path.join(artifacts, 'preview-settings.png'), (await win.capturePage()).toPNG());
    await win.webContents.executeJavaScript('saveSettings()');
    cursor = outside;
    win.hide();
    await waitUntil(() => previewWindow()?.isVisible());
    let preview = previewWindow();
    await pause(100);
    assert.deepEqual(await previewIds(preview), [10231, 1049, 10188], 'preview must match the first three unfinished rows, including bugs');
    assert.equal(preview.isAlwaysOnTop(), true);
    assert.equal(preview.isFocusable(), false);
    assert.equal(win.isVisible(), false, 'preview must not expand the full panel');
    assert(preview.getBounds().x + preview.getBounds().width < ball.getBounds().x, 'left preview must remain left of the ball');
    fs.writeFileSync(path.join(artifacts, 'preview-left.png'), (await preview.capturePage()).toPNG());
    const clickPreviewRow = async index => {
      const point = await preview.webContents.executeJavaScript(
        "(function () { const row = document.querySelectorAll('#preview-list li')[" + index + "]; const rect = row.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()");
      preview.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      preview.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await pause(150);
    };
    for (const item of [{ index: 0, id: 10231, kind: 'task' }, { index: 1, id: 1049, kind: 'bug' }]) {
      if (item.kind === 'bug') await win.webContents.executeJavaScript('openSettings()');
      await clickPreviewRow(item.index);
      assert.equal(win.isVisible(), true, 'clicking a preview row must open the full panel');
      assert.equal(preview.isVisible(), false);
      assert.equal(await win.webContents.executeJavaScript('DT.id'), item.id, 'preview clicks must open the selected item');
      assert.equal(await win.webContents.executeJavaScript('DT.kind'), item.kind, 'task and bug IDs must use their respective detail APIs');
      assert.equal(await win.webContents.executeJavaScript("document.getElementById('detail').hidden"), false);
      assert.equal(await win.webContents.executeJavaScript("document.getElementById('modal').hidden"), true, 'opening a preview item must close any preserved settings overlay');
      enterPanel();
      await pause(100);
      await win.webContents.executeJavaScript('closeDetail()');
      cursor = outside;
      await pause(450);
      assert.equal(preview.isVisible(), true, 'preview must return after leaving the selected detail');
    }
    enterBall();
    await pause(200);
    assert.equal(win.isVisible(), true);
    assert.equal(preview.isVisible(), false, 'full panel must replace the preview on hover');
    cursor = outside;
    await pause(450);
    assert.equal(win.isVisible(), false);
    assert.equal(preview.isVisible(), true, 'preview must return after hover collapse');

    ball.setPosition(area.x + Math.floor((area.width - originalBall.width) / 2), area.y + 48);
    await win.webContents.executeJavaScript(
      "openSettings(); document.getElementById('f-previewSide').value = 'right'; saveSettings()");
    win.hide();
    await pause(450);
    assert(preview.getBounds().x > ball.getBounds().x + ball.getBounds().width, 'selected right side must be respected');
    fs.writeFileSync(path.join(artifacts, 'preview-right.png'), (await preview.capturePage()).toPNG());
    const savedPreview = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
    assert.equal(savedPreview.showTopThree, true);
    assert.equal(savedPreview.previewSide, 'right', 'settings must persist the selected side');
    ball.setPosition(area.x + area.width - originalBall.width, area.y + area.height - originalBall.height);
    await pause(450);
    const rightPreviewBounds = preview.getBounds();
    assert.equal(ball.getBounds().x, area.x + area.width - originalBall.width, 'preview must not force the ball away from the right edge');
    assert(rightPreviewBounds.x + rightPreviewBounds.width < ball.getBounds().x, 'right-side preference must flip left when the right edge has no room');
    assert(rightPreviewBounds.y + rightPreviewBounds.height <= area.y + area.height, 'preview must stay above the taskbar');
    await clickPreviewRow(2);
    assert.equal(win.isVisible(), true, 'auto-flipped preview must remain clickable');
    assert.equal(await win.webContents.executeJavaScript('DT.id'), 10188);
    enterPanel();
    await pause(100);
    await win.webContents.executeJavaScript('closeDetail()');
    cursor = outside;
    await pause(450);

    const originalItems = main.exports.getState().items.slice();
    const replaceItems = items => {
      const current = main.exports.getState().items;
      current.splice(0, current.length, ...items);
      main.exports.pushState();
    };
    replaceItems([{ id: 1, kind: 'task', name: '<img src=x onerror=alert(1)>', status: 'doing', pri: 1 }]);
    await pause(100);
    assert.deepEqual(await previewIds(preview), [1], 'fewer than three items must show only available rows');
    assert.equal(preview.getSize()[1], 80);
    assert.equal(await preview.webContents.executeJavaScript("document.querySelector('.name').textContent"), '<img src=x onerror=alert(1)>');
    assert.equal(await preview.webContents.executeJavaScript("document.querySelectorAll('img').length"), 0, 'task titles must render as text');
    replaceItems([]);
    assert.equal(preview.isVisible(), false, 'empty state must hide the preview');
    replaceItems(originalItems);
    await pause(100);
    assert.equal(preview.isVisible(), true, 'state updates must restore the preview when tasks appear');
    assert.deepEqual(await previewIds(preview), [10231, 1049, 10188]);

    await win.webContents.executeJavaScript(
      "openSettings(); document.getElementById('f-showTopThree').checked = false; saveSettings()");
    await pause(100);
    assert.equal(preview.isVisible(), false, 'disabling the setting must hide the preview');
    await win.webContents.executeJavaScript(
      "openSettings(); document.getElementById('f-showTopThree').checked = true; document.getElementById('f-previewSide').value = 'left'; saveSettings()");
    win.hide();
    ball.setPosition(area.x, area.y);
    await pause(450);
    assert.equal(ball.getBounds().x, area.x, 'preview must not force the ball away from the left edge');
    assert(preview.getBounds().x > ball.getBounds().x + ball.getBounds().width, 'left-side preference must flip right when the left edge has no room');
    ball.setPosition(area.x + Math.floor((area.width - originalBall.width) / 2), area.y + 48);
    await pause(100);
    assert(preview.getBounds().x + preview.getBounds().width < ball.getBounds().x, 'preview must return to the preferred side when room becomes available');
    main.exports.showAndFocus();
    enterPanel();
    await win.webContents.executeJavaScript(
      "openSettings(); document.getElementById('f-displayMode').value = 'panel'; saveSettings()");
    cursor = outside;
    await pause(450);
    assert.equal(win.isVisible(), true, 'resident mode must keep the complete panel visible after mouse leave');
    assert.equal(ball.isVisible(), false, 'resident mode must hide the floating ball');
    assert.equal(preview.isVisible(), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).displayMode, 'panel');
    win.hide();
    await main.exports.doRefresh('timer');
    enterBall();
    await pause(200);
    assert.equal(win.isVisible(), false, 'resident mode must respect intentional hiding and disable hover expansion');
    assert.equal(ball.isVisible(), false, 'intentional hiding in resident mode must keep the ball hidden');
    main.exports.showAndFocus();
    await win.webContents.executeJavaScript(
      "openSettings(); document.getElementById('f-displayMode').value = 'ball'; saveSettings()");
    cursor = outside;
    await pause(450);
    assert.equal(ball.isVisible(), true, 'switching back to ball mode must restore the floating ball');
    assert.equal(win.isVisible(), false, 'ball mode must restore mouse-leave collapse');
    enterBall();
    await pause(200);
    assert.equal(win.isVisible(), true, 'ball mode must restore hover expansion');
    enterPanel();
    await win.webContents.executeJavaScript("window.zt.saveConfig({displayMode:'panel'})");
    cursor = outside;
    const refreshedAt = main.exports.getState().at;
    await pause(31000);
    assert(main.exports.getState().at > refreshedAt, 'scheduled refresh must have run');
    assert.equal(win.isVisible(), true, 'scheduled refresh must keep the resident panel visible with the pointer outside');
    assert.equal(win.isAlwaysOnTop(), true, 'idle refresh must keep the window pinned');
    const text = await win.webContents.executeJavaScript('document.body.innerText');
    assert(text.includes('禅道'));
    fs.writeFileSync(path.join(output, 'idle.png'), (await win.capturePage()).toPNG());
    snapshot('after-idle-refresh');
    // Recreate the native windows using settings reloaded from disk.
    cursor = outside;
    await win.webContents.executeJavaScript("window.zt.saveConfig({showTopThree:true, previewSide:'right', displayMode:'ball'})");
    main.exports.getFloatingBall().destroy();
    win.destroy();
    main.exports.loadConfig();
    main.exports.createWindow();
    await waitUntil(() => previewWindow()?.isVisible());
    preview = previewWindow();
    assert.equal(main.exports.getWindow().isVisible(), false, 'restoring saved settings must keep the full panel collapsed');
    assert.equal(await main.exports.getWindow().webContents.executeJavaScript("(async () => (await window.zt.boot()).config.previewSide)()"), 'right', 'recreated windows must restore the saved preference while allowing automatic side changes');
    const stored = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
    delete stored.displayMode;
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify(stored));
    const previousController = main.exports.getFloatingBall();
    previousController.destroy();
    main.exports.getWindow().destroy();
    main.exports.loadConfig();
    main.exports.createWindow();
    await waitUntil(() => main.exports.getFloatingBall() !== previousController && main.exports.getFloatingBall().window.isVisible() && previewWindow()?.isVisible());
    cursor = outside;
    await pause(450);
    assert.equal(main.exports.getWindow().isVisible(), false, 'profiles without a saved display mode must start with only the floating ball and optional preview');
    assert.equal(previewWindow().isVisible(), true);
    assert.equal(await main.exports.getWindow().webContents.executeJavaScript("(async () => (await window.zt.boot()).config.displayMode)()"), 'ball');
    await main.exports.getWindow().webContents.executeJavaScript("window.zt.saveConfig({displayMode:'panel'})");
    const previousBackgroundController = main.exports.getFloatingBall();
    previousBackgroundController.destroy();
    main.exports.getWindow().destroy();
    process.argv.push('--background');
    main.exports.createWindow();
    await waitUntil(() => main.exports.getFloatingBall() !== previousBackgroundController && readyWindows.has(main.exports.getFloatingBall().window));
    assert.equal(main.exports.getWindow().isVisible(), false, 'silent startup must respect background mode even with a resident panel preference');
    assert.equal(main.exports.getFloatingBall().window.isVisible(), false, 'a saved resident preference must not reveal the ball when its page becomes ready');
    process.argv.splice(process.argv.indexOf('--background'), 1);
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