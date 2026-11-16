'use strict';

const { app, BrowserWindow, screen, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const output = process.env.ZT_WINDOW_TEST_DIR;
const profile = path.join(output, 'user-data');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setLoginItemSettings = () => {};
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  baseUrl: 'https://example.invalid', account: 'recovery-test', autoUpdate: false,
  displayMode: 'ball', alwaysOnTop: true, showTopThree: true,
}));
process.argv.push('--mock');

const source = path.resolve(__dirname, '../../electron/main.js');
const main = new Module(source, module);
main.filename = source;
main.paths = Module._nodeModulePaths(path.dirname(source));
main._compile(fs.readFileSync(source, 'utf8') + `
module.exports = { getWindow: () => win, getFloatingBall: () => floatingBall,
  doRefresh, showAndFocus, toggleWindow, saveConfig, pushState };
`, source);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description) {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + description);
    await pause(25);
  }
}
const report = value => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(value, null, 2));

app.whenReady().then(async () => {
  screen.getCursorScreenPoint = () => ({ x: -100000, y: -100000 });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(file|data):/.test(details.url) });
  });
  try {
    const preview = () => BrowserWindow.getAllWindows().find(window => window.getTitle() === '禅道常驻待办');
    await until(() => main.exports.getFloatingBall()?.window.isVisible() && preview()?.isVisible(), 'initial ball and preview');
    const panel = main.exports.getWindow();
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = main.exports.getFloatingBall();
      previous.window.destroy();
      await until(() => main.exports.getFloatingBall() !== previous && main.exports.getFloatingBall().window.isVisible(), 'replacement floating ball');
      await until(() => preview()?.isVisible(), 'replacement preview');
      assert.equal(panel.isVisible(), false, 'recovery must preserve the collapsed panel');
      assert.equal(main.exports.getFloatingBall().window.isAlwaysOnTop(), true);
      assert.equal(main.exports.getFloatingBall().window.isFocusable(), false);
      assert.equal(BrowserWindow.getAllWindows().length, 3, 'recovery must not duplicate windows');
      assert.equal(panel.listenerCount('resize'), 1, 'old controller listeners must be removed');
      await main.exports.doRefresh('recovery-test');
      main.exports.showAndFocus();
      assert.equal(panel.isVisible(), true, 'second-instance restoration must still work');
      main.exports.toggleWindow();
      assert.equal(panel.isVisible(), false, 'tray hiding must still work');
    }

    main.exports.showAndFocus();
    await panel.webContents.executeJavaScript("openTaskAction('start', {id:10231, name:'Synthetic recovery task', kind:'task', status:'wait'})");
    await until(() => panel.webContents.executeJavaScript("!document.getElementById('task-modal').hidden"), 'task dialog');
    main.exports.getFloatingBall().window.destroy();
    await until(() => main.exports.getFloatingBall().window.isVisible(), 'ball while task dialog is open');
    await pause(500);
    assert.equal(panel.isVisible(), true, 'recovery must preserve an open task dialog');
    await panel.webContents.executeJavaScript('closeTaskAction()');
    await until(() => !panel.isVisible(), 'normal collapse after dialog dismissal');

    main.exports.saveConfig({ displayMode: 'panel' });
    main.exports.pushState();
    const residentController = main.exports.getFloatingBall();
    residentController.window.destroy();
    await until(() => main.exports.getFloatingBall() !== residentController, 'resident controller recovery');
    await pause(200);
    assert.equal(panel.isVisible(), true);
    assert.equal(main.exports.getFloatingBall().window.isVisible(), false, 'resident mode must keep the ball hidden');
    assert.equal(preview()?.isVisible(), false);

    panel.hide();
    const hiddenController = main.exports.getFloatingBall();
    hiddenController.window.destroy();
    await until(() => main.exports.getFloatingBall() !== hiddenController, 'hidden resident controller recovery');
    await pause(200);
    assert.equal(panel.isVisible(), false, 'recovery must respect intentional hiding in resident mode');

    main.exports.getFloatingBall().destroy();
    await pause(100);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'explicit cleanup must not recreate owned windows');
    report({ passed: true });
    app.__quitting = true;
    app.quit();
  } catch (error) {
    report({ passed: false, error: error.stack });
    app.__quitting = true;
    app.exit(1);
  }
});
