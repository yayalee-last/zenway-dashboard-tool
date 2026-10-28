'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');

// Execute the real controller with native-window doubles that reject calls after destruction.
function floatingHarness() {
  const windows = [], timers = new Map(), moves = [];
  let nextTimer = 0, cursor = { x: -10000, y: -10000 };
  class Window extends EventEmitter {
    constructor(bounds) {
      super();
      this.bounds = { ...bounds };
      this.visible = false;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.send = () => {};
      windows.push(this);
    }
    alive() { if (this.destroyed) throw new TypeError('Object has been destroyed'); }
    isDestroyed() { return this.destroyed; }
    getBounds() { this.alive(); return { ...this.bounds }; }
    getSize() { this.alive(); return [this.bounds.width, this.bounds.height]; }
    setPosition(x, y) { this.alive(); Object.assign(this.bounds, { x, y }); }
    setBounds(bounds) { this.alive(); Object.assign(this.bounds, bounds); }
    setAlwaysOnTop() { this.alive(); }
    isVisible() { this.alive(); return this.visible; }
    showInactive() { this.alive(); this.visible = true; this.emit('show'); }
    hide() {
      this.alive();
      if (this.visible) { this.visible = false; this.emit('hide'); }
    }
    loadFile() {}
    destroy() { this.alive(); this.destroyed = true; this.emit('closed'); }
  }
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const schedule = (callback, interval) => {
    const id = ++nextTimer;
    timers.set(id, { callback, interval });
    return id;
  };
  const context = {
    module: { exports: {} }, __dirname: path.join(__dirname, '../electron'), process,
    require(name) {
      if (name === 'electron') return { BrowserWindow: Window, screen: {
        getPrimaryDisplay: () => ({ workArea: area }),
        getDisplayMatching: () => ({ workArea: area }),
        getCursorScreenPoint: () => cursor,
      } };
      if (name === '../renderer/item-order') return require('../renderer/item-order');
      return require(name);
    },
    setInterval: callback => schedule(callback, true),
    setTimeout: callback => schedule(callback, false),
    clearInterval: id => timers.delete(id),
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/floating-ball.js'), 'utf8'), context,
    { filename: 'electron/floating-ball.js' });
  const panel = new Window({ x: 100, y: 100, width: 380, height: 520 });
  const floating = context.module.exports.createFloatingBall(panel, null, point => moves.push(point));
  const ball = floating.window;
  floating.setDisplayMode('ball');
  ball.emit('ready-to-show');
  floating.updatePreview({ showTopThree: true }, [{ id: 1, kind: 'task', status: 'doing', pri: 1 }]);
  const preview = windows.at(-1);
  preview.emit('ready-to-show');
  const runTimers = () => {
    for (const [id, timer] of [...timers]) {
      if (!timers.has(id)) continue;
      if (!timer.interval) timers.delete(id);
      timer.callback();
    }
  };
  cursor = { x: ball.bounds.x + 8, y: ball.bounds.y + 8 };
  runTimers();
  cursor = { x: -10000, y: -10000 };
  runTimers(); // Queue a collapse while the pointer interval remains active.
  ball.emit('move'); // Queue a pending position save as well.
  return { panel, ball, preview, floating, moves, runTimers };
}

for (const target of ['ball', 'panel']) {
  test('destroying the native ' + target + ' stops floating callbacks and disposes owned windows', () => {
    const h = floatingHarness();
    h[target].destroy();
    assert.doesNotThrow(h.runTimers, 'no queued callback may touch a destroyed window');
    assert.equal(h.ball.isDestroyed(), true);
    assert.equal(h.preview.isDestroyed(), true);
    assert.deepEqual(h.moves, [], 'a disposed controller must not save a stale position');
    assert.doesNotThrow(() => h.floating.destroy(), 'application shutdown may repeat cleanup');
  });
}

test('explicit floating cleanup cancels queued work and is safe to repeat', () => {
  const h = floatingHarness();
  h.floating.destroy();
  assert.doesNotThrow(() => h.floating.destroy());
  assert.doesNotThrow(h.runTimers);
  assert.equal(h.panel.isDestroyed(), false, 'the controller does not own the main panel');
  assert.equal(h.ball.isDestroyed(), true);
  assert.equal(h.preview.isDestroyed(), true);
  assert.deepEqual(h.moves, []);
});

test('task dialog suspends queued collapse until dismissal', () => {
  const h = floatingHarness();
  h.floating.setTaskDialogOpen(true);
  h.runTimers();
  h.runTimers();
  assert.equal(h.panel.isVisible(), true, 'an open dialog must cancel collapse already queued by mouse leave');
  h.floating.setTaskDialogOpen(false);
  h.runTimers();
  h.runTimers();
  assert.equal(h.panel.isVisible(), false, 'dismissal must restore normal mouse-leave collapse');
  h.floating.destroy();
});

const execFileAsync = promisify(execFile);

test('close-task confirmation preserves the hover panel under its original pointer', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-task-dialog-test-'));
  t.after(() => fs.promises.rm(output, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const env = { ...process.env, ZT_WINDOW_TEST_DIR: output };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await execFileAsync(require('electron'), [path.join(__dirname, 'fixtures/task-action-dialog.cjs')], {
      env, windowsHide: true, timeout: 15000,
    });
  } catch (error) {
    const report = path.join(output, 'result.json');
    if (fs.existsSync(report)) error.message += '\n' + fs.readFileSync(report, 'utf8');
    throw error;
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8')).passed, true);
});

test('Windows floating ball expands on hover and preserves widget window state', {
  skip: process.platform !== 'win32', timeout: 100000,
}, async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-window-test-'));
  t.after(() => fs.promises.rm(output, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const env = { ...process.env, ZT_WINDOW_TEST_DIR: output };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    // 包含 31 秒定时刷新等待，以及多轮原生窗口创建和截图。
    await execFileAsync(require('electron'), [path.join(__dirname, 'fixtures/window-lifecycle.cjs')], {
      env, windowsHide: true, timeout: 90000,
    });
  } catch (error) {
    const report = path.join(output, 'result.json');
    if (fs.existsSync(report)) error.message += '\n' + fs.readFileSync(report, 'utf8');
    throw error;
  }
  const result = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
  assert.equal(result.passed, true);
  assert.equal(result.samples.length, 5);
});

test('resident panel keeps its dragged position when opening details and settings', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-position-test-'));
  t.after(() => fs.promises.rm(output, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const env = { ...process.env, ZT_WINDOW_TEST_DIR: output };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await execFileAsync(require('electron'), [path.join(__dirname, 'fixtures/resident-position.cjs')], {
      env, windowsHide: true, timeout: 15000,
    });
  } catch (error) {
    const report = path.join(output, 'result.json');
    if (fs.existsSync(report)) error.message += '\n' + fs.readFileSync(report, 'utf8');
    throw error;
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8')).passed, true);
});

test('completed tasks can be closed from list and details, with persistent sorting', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-task-list-test-'));
  t.after(() => fs.promises.rm(output, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const env = { ...process.env, ZT_WINDOW_TEST_DIR: output };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await execFileAsync(require('electron'), [path.join(__dirname, 'fixtures/task-list.cjs')], {
      env, windowsHide: true, timeout: 15000,
    });
  } catch (error) {
    const report = path.join(output, 'result.json');
    if (fs.existsSync(report)) error.message += '\n' + fs.readFileSync(report, 'utf8');
    throw error;
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8')).passed, true);
});
