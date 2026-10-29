'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(t, { packaged = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-check-test-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let now = 0, nextId = 0;
  const timers = new Map();
  const clock = {
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    setInterval(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay, repeat: delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending() { return [...timers.values()].filter(timer => !timer.repeat).length; },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        if (timer.repeat) timers.set(id, { ...timer, at: timer.at + timer.repeat });
        else timers.delete(id);
        now = timer.at;
        await timer.fn();
      }
      now = end;
    },
  };
  class FakeDate extends Date { static now() { return now; } }
  const handlers = new Map(), messages = [];
  const app = {
    isPackaged: packaged, setName() {}, getPath: () => directory, getVersion: () => '0.3.4',
    requestSingleInstanceLock: () => false, quit() {},
  };
  const electron = { app, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} } };
  const source = path.resolve(__dirname, '../electron/main.js');
  const realRequire = createRequire(source);
  const context = vm.createContext({
    require(name) { return name === 'electron' ? electron : realRequire(name); },
    module: { exports: {} }, __dirname: path.dirname(source), __filename: source,
    process: { argv: [], execPath: process.execPath, platform: process.platform, env: {} },
    Buffer, console, AbortController, Date: FakeDate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearTimeout,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8') + `
module.exports = {
  scheduleUpdateChecks, checkUpdate, publicUpdate, wireIpc,
  configure(value) { config = { ...config, ...value }; },
  setUpdater(value) { updater = value; },
  setClient(value) { client = value; },
  setWindow(value) { win = value; },
  setUpdate(value) { update = { ...update, ...value }; }
};`, context, { filename: source });
  const main = context.module.exports;
  main.setClient({ configured: false, applyConfig() {} });
  const webContents = { mainFrame: {}, send: (channel, state) => messages.push({ channel, state }) };
  main.setWindow({ isDestroyed: () => false, setAlwaysOnTop() {}, webContents });
  main.wireIpc();
  return { main, app, clock, messages, save: patch => handlers.get('config:save')(null, patch),
    invoke: (name, event = { sender: webContents, senderFrame: webContents.mainFrame }) => handlers.get(name)(event),
  };
}

const latest = () => ({ ok: true, latest: 'v0.3.5', hasUpdate: true, asset: { kind: 'app' } });

test('automatic checks start after startup delay and repeat every five minutes', async t => {
  const f = fixture(t);
  let calls = 0;
  f.main.setUpdater({ async check() { calls++; return latest(); } });
  f.main.scheduleUpdateChecks();
  await f.clock.advance(7999);
  assert.equal(calls, 0);
  await f.clock.advance(1);
  assert.equal(calls, 1);
  assert.equal(f.main.publicUpdate().hasUpdate, true);
  assert(f.messages.some(message => message.channel === 'update' && message.state.latest === 'v0.3.5'));
  await f.clock.advance(5 * 60 * 1000 - 1);
  assert.equal(calls, 1);
  await f.clock.advance(1);
  assert.equal(calls, 2);
  assert.equal(f.clock.pending(), 1);
});

test('saved auto-check setting cancels pending work and takes effect without restart', async t => {
  const f = fixture(t);
  let calls = 0;
  f.main.setUpdater({ async check() { calls++; return latest(); } });
  f.main.scheduleUpdateChecks();
  await f.save({ autoUpdate: false });
  assert.equal(f.clock.pending(), 0);
  await f.clock.advance(10 * 60 * 1000);
  assert.equal(calls, 0);
  await f.save({ autoUpdate: true });
  await f.clock.advance(0);
  assert.equal(calls, 1);
  await f.save({ autoUpdate: true });
  assert.equal(f.clock.pending(), 1, 'saving the same setting must not add another timer');
  await f.clock.advance(5 * 60 * 1000);
  assert.equal(calls, 2);
});

test('failed checks reset checking state and retry at the next normal interval', async t => {
  const f = fixture(t);
  let calls = 0;
  f.main.setUpdater({ async check() { if (++calls === 1) throw new Error('offline'); return latest(); } });
  f.main.scheduleUpdateChecks();
  await f.clock.advance(8000);
  assert.equal(f.main.publicUpdate().checking, false);
  assert.equal(f.main.publicUpdate().error, 'offline');
  await f.clock.advance(5 * 60 * 1000);
  assert.equal(calls, 2);
  assert.equal(f.main.publicUpdate().error, null);
  assert.equal(f.main.publicUpdate().hasUpdate, true);
});

test('development mode skips automatic checks while manual checks remain available', async t => {
  const f = fixture(t, { packaged: false });
  let calls = 0;
  f.main.setUpdater({ async check() { calls++; return latest(); } });
  f.main.scheduleUpdateChecks();
  await f.clock.advance(10 * 60 * 1000);
  assert.equal(calls, 0);
  await f.main.checkUpdate();
  assert.equal(calls, 1);
  f.app.__quitting = true;
  f.main.scheduleUpdateChecks();
  assert.equal(f.clock.pending(), 0);
});

test('checking and downloading do not trigger overlapping release requests', async t => {
  const f = fixture(t);
  let calls = 0, finish;
  f.main.setUpdater({ check() { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = f.main.checkUpdate();
  assert.equal((await f.main.checkUpdate()).checking, true);
  assert.equal(calls, 1);
  finish(latest());
  await pending;
  f.main.setUpdate({ downloading: true });
  f.main.scheduleUpdateChecks();
  await f.clock.advance(8000);
  assert.equal(calls, 1);
});

test('cancel IPC aborts only the active download and allows retry', async t => {
  const f = fixture(t);
  let attempts = 0, installs = 0, activeSignal;
  f.main.setUpdate({ ...latest(), asset: { kind: 'app' } });
  f.main.setUpdater({
    download(_asset, onProgress, { signal }) {
      attempts++;
      activeSignal = signal;
      onProgress({ percent: 25 });
      if (attempts > 1) return Promise.resolve({ zipPath: 'fixture.zip' });
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async install() { installs++; return { script: {} }; },
  });
  const pending = f.invoke('update:install');
  assert.equal(f.main.publicUpdate().canCancel, true);
  assert.equal((await f.invoke('update:install')).ok, false);
  assert.equal((await f.invoke('update:cancel', { sender: {}, senderFrame: {} })).ok, false);
  assert.equal(activeSignal.aborted, false, 'foreign renderer must not cancel the download');
  assert.equal((await f.invoke('update:cancel')).ok, true);
  const cancelled = await pending;
  assert.equal(cancelled.cancelled, true);
  assert.equal(f.main.publicUpdate().downloading, false);
  assert.equal(f.main.publicUpdate().canCancel, false);
  assert.equal(f.main.publicUpdate().percent, null);
  assert.equal(f.main.publicUpdate().error, null);
  assert.equal(installs, 0);
  assert.equal((await f.invoke('update:install')).ok, true);
  assert.equal(attempts, 2);
  assert.equal(installs, 1);
});

test('download failure releases state so the same update can be downloaded again', async t => {
  const f = fixture(t);
  let attempts = 0;
  f.main.setUpdate({ ...latest(), asset: { kind: 'app' } });
  f.main.setUpdater({
    async download() {
      if (++attempts === 1) throw new Error('更新下载超时，请检查网络后重试');
      return { zipPath: 'fixture.zip' };
    },
    async install() { return { script: {} }; },
  });
  const failed = await f.invoke('update:install');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /超时/);
  assert.equal(f.main.publicUpdate().downloading, false);
  assert.equal(f.main.publicUpdate().canCancel, false);
  assert.equal(f.main.publicUpdate().percent, null);
  assert.equal((await f.invoke('update:install')).ok, true);
  assert.equal(attempts, 2);
  assert.equal(f.main.publicUpdate().error, null);
});

test('cancellation is unavailable once download has entered installation', async t => {
  const f = fixture(t);
  let finishInstall;
  let enteredInstall;
  const installing = new Promise(resolve => { enteredInstall = resolve; });
  f.main.setUpdate({ ...latest(), asset: { kind: 'app' } });
  f.main.setUpdater({
    async download() { return { zipPath: 'fixture.zip' }; },
    install() { enteredInstall(); return new Promise(resolve => { finishInstall = resolve; }); },
  });
  const pending = f.invoke('update:install');
  await installing;
  assert.equal(f.main.publicUpdate().downloading, true);
  assert.equal(f.main.publicUpdate().canCancel, false);
  assert.equal((await f.invoke('update:cancel')).ok, false);
  assert.equal((await f.invoke('update:install')).ok, false);
  finishInstall({ script: {} });
  assert.equal((await pending).ok, true);
});
