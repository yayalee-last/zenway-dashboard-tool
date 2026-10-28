'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Execute real handlers without starting Electron, creating config or reaching a server.
function mainFixture(details = []) {
  const handlers = new Map(), reads = [], writes = [], messages = [];
  const tasks = new Map(details.map(task => [Number(task.id), task]));
  const home = [];
  const client = {
    configured: true,
    async getTaskDetail(id) {
      reads.push(id);
      const value = tasks.get(id);
      if (value instanceof Error) throw value;
      return value;
    },
    taskUrl: id => 'https://zentao.invalid/task-view-' + id + '.html',
    async fetchMyTasks() { return { items: home.slice(), strategy: 'fixture' }; },
    async fetchMyBugs() { return { items: [] }; },
  };
  for (const [method, status] of [['startTask', 'doing'], ['finishTask', 'done'], ['closeTask', 'closed']]) {
    client[method] = async (id, payload) => {
      writes.push({ method, id, payload });
      tasks.get(id).status = status;
    };
  }
  const frame = {}, webContents = { mainFrame: frame, send: (...args) => messages.push(args) };
  const event = { sender: webContents, senderFrame: frame };
  const electron = {
    app: { setName() {}, getPath: () => os.tmpdir(), requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    shell: { openExternal() { assert.fail('fixture must not open external programs'); } },
  };
  const source = path.resolve(__dirname, '../../electron/main.js'), realRequire = createRequire(source);
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electron;
      if (name === './zentao') return { ZentaoClient: class { constructor() { assert.fail('real client not allowed'); } }, ZentaoError: Error };
      if (name === './updater') return { Updater: class { constructor() { assert.fail('real updater not allowed'); } } };
      if (name === './floating-ball') return { createFloatingBall() { assert.fail('window creation not allowed'); } };
      if (/^(node:)?https?$/.test(name)) assert.fail('network not allowed');
      return realRequire(name);
    },
    module: { exports: {} }, __dirname: path.dirname(source), __filename: source,
    process: { argv: [], platform: process.platform }, Buffer, console,
    fetch() { assert.fail('network not allowed'); },
    setTimeout(fn) { fn(); return 1; }, clearTimeout() {}, setInterval() { assert.fail('polling not allowed'); }, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(source, 'utf8') + `
module.exports = {
  setup(c, window) { config = { ...config, account: 'Me', baseUrl: 'https://zentao.invalid' }; client = c; win = window; wireIpc(); },
  setFloatingBall(value) { floatingBall = value; },
  state() { return state; }
};`, context, { filename: source });
  context.module.exports.setup(client, { webContents, isDestroyed: () => false });
  return { handlers, client, home, tasks, reads, writes, messages, event,
    state: context.module.exports.state,
    setFloatingBall: context.module.exports.setFloatingBall,
    invoke: (channel, value, sender = event) => handlers.get(channel)(sender, value) };
}

// A deliberately small deterministic DOM: no browser navigation, timers or downloads.
class Element {
  constructor(tag, root = false) {
    this.tagName = tag; this.children = []; this.parentNode = null; this.root = root;
    this.className = ''; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = {};
    this.hidden = false; this.disabled = false; this._text = '';
    const tokens = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      contains: name => tokens().includes(name),
      add: name => { this.className = [...new Set([...tokens(), name])].join(' '); },
      remove: name => { this.className = tokens().filter(token => token !== name).join(' '); },
      toggle: (name, force) => {
        const add = force === undefined ? !tokens().includes(name) : force;
        this.classList[add ? 'add' : 'remove'](name);
      },
    };
  }
  get isConnected() { return this.root || Boolean(this.parentNode && this.parentNode.isConnected); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(value) { this.textContent = value; }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#fragment') { this.append(...node.children.slice()); continue; }
      if (node.parentNode) node.remove();
      node.parentNode = this; this.children.push(node);
    }
  }
  prepend(node) { node.parentNode = this; this.children.unshift(node); }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  get nextElementSibling() { return this.parentNode && this.parentNode.children[this.parentNode.children.indexOf(this) + 1]; }
  insertAdjacentElement(position, node) {
    assert.equal(position, 'afterend');
    node.parentNode = this.parentNode;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, node);
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  async click() { if (!this.disabled) for (const fn of this.listeners.click || []) await fn({ target: this, stopPropagation() {}, preventDefault() {} }); }
  setAttribute(name, value) { this.attributes[name] = value; if (name === 'class') this.className = value; }
  getAttribute(name) { return this.attributes[name]; }
  querySelectorAll(selector) {
    const match = node => selector.startsWith('.') ? selector.slice(1).split('.').every(cls => node.classList.contains(cls)) : node.tagName === selector;
    return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  focus() {}
  select() {}
}

function rendererFixture(taskDetail) {
  const nodes = new Map(), opened = [], resized = [];
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Element('div', true));
      return nodes.get(id);
    },
    createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag),
    createDocumentFragment: () => new Element('#fragment'),
    createTextNode(text) { const node = new Element('#text'); node.textContent = text; return node; },
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    document, console,
    window: { ItemOrder: require('../../renderer/item-order'), zt: {
      taskDetail, open: url => opened.push(url), resize: height => resized.push(height),
      setTaskDialogOpen() {},
    } },
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {},
  });
  const source = path.resolve(__dirname, '../../renderer/app.js');
  vm.runInContext(fs.readFileSync(source, 'utf8').split('(async function init()')[0] + `
this.fixture = { S, DT, renderItem, renderDetail, renderStatus, visibleItems, toggleTree, openDetail, closeDetail, loadDetail, openTaskAction, childrenNotice, pending: () => pending };`, context, { filename: source });
  const api = context.fixture;
  api.S.cfg = { baseUrl: 'https://zentao.invalid', account: 'Me', urlMode: 'get' };
  return { ...api, document, nodes, opened, resized,
    node: id => document.getElementById(id),
    row(task) { const row = api.renderItem(task); document.getElementById('list').append(row); return row; } };
}

module.exports = { mainFixture, rendererFixture };
