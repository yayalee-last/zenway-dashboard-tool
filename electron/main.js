'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen } = require('electron');
const { ZentaoClient, ZentaoError, normalizeBaseUrl } = require('./zentao');
const { Updater } = require('./updater');
const { createFloatingBall } = require('./floating-ball');
const { accountOf, isMine, assigneeName, taskChildren, isParentTask } = require('./task-context');

app.setName('zentao-widget');

const STATE_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const UPDATE_POLL_MS = 5 * 60 * 1000; // 常驻时每 5 分钟自动检测新版本

const DEFAULT_CONFIG = {
  baseUrl: '',
  account: '',
  password: '',
  urlMode: 'get',
  intervalSec: 180,
  alwaysOnTop: true,
  autoLaunch: false,
  autoUpdate: true,
  showTopThree: false,
  previewSide: 'left',
  displayMode: 'ball',
  sortMode: 'priority',
  bounds: null,
  ballPosition: null,
};

let win = null;
let floatingBall = null;
let tray = null;
let client = null;
let config = { ...DEFAULT_CONFIG };
let timer = null;
let updateTimer = null;
let refreshing = false;
let state = { ok: false, items: [], at: 0, error: null, needSetup: true };
let updater = null;
let update = {
  checking: false,
  downloading: false,
  checkedAt: 0,
  latest: null,
  hasUpdate: false,
  notes: '',
  asset: null,
  percent: null,
  error: null,
};

/* ---------------- 配置 ---------------- */

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch (e) {
    console.error('[config] 读取失败', e);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

function saveConfig(patch = {}) {
  config = { ...config, ...patch };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('[config] 写入失败', e);
  }
  return config;
}

function publicConfig() {
  return { ...config };
}

/* ---------------- 托盘与应用共用图标 ---------------- */

function makeTrayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'))
    .resize({ width: 20, height: 20 });
}

/* ---------------- 窗口 ---------------- */

function syncWindowPin() {
  if (!win || win.isDestroyed()) return;
  // floating 会在 Windows 上重新排到任务栏之后，任务栏降层时也会让挂件失去置顶。
  const level = process.platform === 'win32' ? 'pop-up-menu' : 'floating';
  win.setAlwaysOnTop(Boolean(config.alwaysOnTop), level);
}

function createWindow() {
  const shotArg = process.argv.find((a) => a.startsWith('--shot='));
  const area = screen.getPrimaryDisplay().workArea;
  const W = 380;
  const H = Math.min(580, area.height - 80);
  const saved = config.bounds;
  const bounds = saved && Number.isFinite(saved.x)
    ? { width: W, height: H, x: saved.x, y: saved.y }
    : { width: W, height: H, x: area.x + area.width - W - 28, y: area.y + 48 };

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    show: false,
    title: '禅道挂件',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  syncWindowPin();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), process.argv.includes('--setup') ? { query: { setup: '1' } } : undefined);

  // 描述里的链接一律丢给系统浏览器，别让挂件自己跑过去
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.once('ready-to-show', () => {
    if (shotArg) {
      win.show();
    } else {
      floatingBall = createFloatingBall(win, config.ballPosition, (ballPosition) => saveConfig({ ballPosition }));
      if (process.argv.includes('--setup')) showAndFocus();
    }
    pushState();
    if (process.argv.includes('--background')) win.hide();
  });

  // 调试用：--shot=<png路径> 截一张图后退出
  if (shotArg) {
    const target = shotArg.slice('--shot='.length);
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.argv.includes('--expand')) {
            await win.webContents.executeJavaScript(
              `(async () => { for (const b of document.querySelectorAll('.expander')) { b.click(); await new Promise(r => setTimeout(r, 600)); } })()`
            );
            await new Promise((r) => setTimeout(r, 900));
          }
          if (process.argv.includes('--detail')) {
            await win.webContents.executeJavaScript(`document.querySelector('.item') && document.querySelector('.item').click()`);
            await new Promise((r) => setTimeout(r, 1600));
          }
          const detailId = process.argv.find((a) => a.startsWith('--detail-id='));
          if (detailId) {
            await win.webContents.executeJavaScript(`openDetail({ id: ${Number(detailId.split('=')[1]) || 0} })`);
            await new Promise((r) => setTimeout(r, 1600));
          }
          if (process.argv.includes('--bug-list')) {
            await win.webContents.executeJavaScript(`document.querySelector('.tab[data-filter="bug"]').click()`);
            await new Promise((r) => setTimeout(r, 500));
          }
          const bugId = process.argv.find((a) => a.startsWith('--bug-detail='));
          if (bugId) {
            await win.webContents.executeJavaScript(`openDetail({ id: ${Number(bugId.split('=')[1]) || 0}, kind: 'bug' })`);
            await new Promise((r) => setTimeout(r, 1800));
          }
          if (process.argv.includes('--bug-action')) {
            await win.webContents.executeJavaScript(
              `(() => {
                 const detailOpen = !document.getElementById('detail').hidden;
                 const b = detailOpen ? document.querySelector('#dt-foot .btn.primary') : document.querySelector('.item .act');
                 if (b) b.click();
               })()`
            );
            await new Promise((r) => setTimeout(r, 700));
          }
          if (process.argv.includes('--bug-submit')) {
            await win.webContents.executeJavaScript(`document.getElementById('bm-ok').click()`);
            await new Promise((r) => setTimeout(r, 900));
          }
          if (process.argv.includes('--hover')) {
            await win.webContents.executeJavaScript(
              `(() => { const s = document.createElement('style'); s.textContent = '.acts{opacity:1!important;pointer-events:auto!important}'; document.head.append(s); })()`
            );
            await new Promise((r) => setTimeout(r, 250));
          }
          if (process.argv.includes('--action')) {
            await win.webContents.executeJavaScript(`document.querySelector('.item .act') && document.querySelector('.item .act').click()`);
            await new Promise((r) => setTimeout(r, 500));
          }
          if (process.argv.includes('--bottom')) {
            await win.webContents.executeJavaScript(
              `(() => {
                 const b = document.getElementById('dt-body'); if (b) b.scrollTop = b.scrollHeight;
                 const p = document.querySelector('.panel'); if (p) p.scrollTop = p.scrollHeight;
               })()`
            );
            await new Promise((r) => setTimeout(r, 300));
          }
          if (process.argv.includes('--update')) {
            await win.webContents.executeJavaScript(`document.getElementById('btn-check-update').click()`);
            await new Promise((r) => setTimeout(r, 2200));
          }
          const img = await win.capturePage();
          fs.writeFileSync(target, img.toPNG());
          console.log(`[shot] ${target}`);
        } catch (e) {
          console.error('[shot] 失败', e);
        }
        app.__quitting = true;
        app.quit();
      }, 1200);
    });
  }

  win.on('moved', () => {
    if (!win) return;
    clearTimeout(win.__moveT);
    win.__moveT = setTimeout(() => {
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      saveConfig({ bounds: { x, y, width, height } });
    }, 500);
  });

  // 关闭 = 收进托盘
  win.on('close', (e) => {
    if (!app.__quitting) {
      e.preventDefault();
      win.hide();
      updateTrayMenu();
    }
  });

  win.on('show', syncWindowPin);
  win.on('restore', syncWindowPin);
  win.on('blur', syncWindowPin);
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else showAndFocus();
  updateTrayMenu();
}

/* ---------------- 托盘 ---------------- */

function buildTrayMenu() {
  const s = openStats();
  return Menu.buildFromTemplate([
    { label: state.ok ? `上次刷新：${fmtTime(state.at)}` : '尚未成功刷新', enabled: false },
    { label: `待办 任务 ${s.task} · 缺陷 ${s.bug}`, enabled: false },
    { type: 'separator' },
    { label: '立即刷新', click: () => doRefresh('tray') },
    { label: '打开禅道', click: () => shell.openExternal(client ? client.indexUrl() : config.baseUrl) },
    { label: '设置…', click: () => { showAndFocus(); win?.webContents.send('open-settings'); } },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: Boolean(config.alwaysOnTop),
      click: (item) => {
        saveConfig({ alwaysOnTop: item.checked });
        syncWindowPin();
        updateTrayMenu();
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: Boolean(config.autoLaunch),
      click: (item) => {
        saveConfig({ autoLaunch: item.checked });
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--background'] });
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    updateMenuItem(),
    {
      label: '退出',
      click: () => {
        app.__quitting = true;
        app.quit();
      },
    },
  ]);
}

function updateMenuItem() {
  if (update.downloading) {
    return { label: `正在下载更新… ${update.percent != null ? update.percent + '%' : ''}`, enabled: false };
  }
  if (update.checking) return { label: '正在检查更新…', enabled: false };
  if (update.hasUpdate && update.latest) {
    return {
      label: `有新版本 ${update.latest}，去更新`,
      click: () => {
        showAndFocus();
        win?.webContents.send('open-update');
      },
    };
  }
  return { label: `检查更新（当前 v${app.getVersion()}）`, click: () => checkUpdate() };
}

function openStats() {
  const skip = new Set(['done', 'closed', 'cancel']);
  let task = 0;
  let bug = 0;
  for (const i of state.items || []) {
    if (skip.has(String(i.status || '').toLowerCase())) continue;
    if (i.kind === 'bug') bug += 1;
    else task += 1;
  }
  return { task, bug, total: task + bug };
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  if (!state.ok) return tray.setToolTip('禅道挂件 · 未连接');
  const s = openStats();
  tray.setToolTip(`禅道挂件 · 待办 ${s.total}（任务 ${s.task} / 缺陷 ${s.bug}）`);
}function createTray() {
  try {
    tray = new Tray(makeTrayIcon());
    tray.on('click', () => toggleWindow());
    updateTrayMenu();
  } catch (e) {
    console.error('[tray] 创建失败', e);
  }
}

/* ---------------- 自动更新 ---------------- */

function publicUpdate() {
  return {
    current: app.getVersion(),
    checking: update.checking,
    downloading: update.downloading,
    checkedAt: update.checkedAt,
    latest: update.latest,
    hasUpdate: update.hasUpdate,
    notes: update.notes,
    percent: update.percent,
    error: update.error,
  };
}

function pushUpdate() {
  if (win && !win.isDestroyed()) win.webContents.send('update', publicUpdate());
}

function scheduleUpdateChecks(delay = 8000) {
  clearTimeout(updateTimer);
  updateTimer = null;
  if (!app.isPackaged || config.autoUpdate === false || app.__quitting) return;
  updateTimer = setTimeout(async () => {
    updateTimer = null;
    try {
      await checkUpdate({ silent: true });
    } finally {
      scheduleUpdateChecks(UPDATE_POLL_MS);
    }
  }, delay);
}

async function checkUpdate({ silent = false } = {}) {
  if (!updater) return publicUpdate();
  if (update.checking || update.downloading) return publicUpdate();

  update.checking = true;
  update.error = null;
  pushUpdate();
  updateTrayMenu();

  let r;
  try {
    r = await updater.check();
  } catch (e) {
    r = { ok: false, error: e.message || String(e) };
  }
  update.checking = false;
  update.checkedAt = Date.now();

  if (r.ok) {
    update.latest = r.latest;
    update.hasUpdate = Boolean(r.hasUpdate);
    update.notes = r.notes || '';
    update.asset = r.asset || null;
    if (r.assetMissing) update.error = `新版本 ${r.latest} 没有适用的更新包，去 GitHub 发行版页面查看`;
  } else {
    update.error = r.error || '检查更新失败';
  }

  pushUpdate();
  updateTrayMenu();
  return publicUpdate();
}

async function installUpdate() {
  if (!updater) return { ok: false, error: '当前是开发模式，不能自更新' };
  if (update.downloading) return { ok: false, error: '正在下载中' };
  if (!update.asset) return { ok: false, error: '没有可用的更新包' };

  update.downloading = true;
  update.percent = 0;
  update.error = null;
  pushUpdate();
  updateTrayMenu();

  try {
    const { zipPath } = await updater.download(update.asset, (p) => {
      update.percent = p.percent;
      pushUpdate();
    });

    // 解压 + 生成替换脚本，成功后才退出自己
    const { script } = await updater.install(zipPath, update.latest, update.asset);
    update.percent = 100;
    pushUpdate();

    setTimeout(async () => {
      try {
        await updater.launchApply(script);
        app.__quitting = true;
        app.quit();
      } catch (e) {
        update.downloading = false;
        update.error = `启动更新助手失败：${e.message || e}`;
        pushUpdate();
        updateTrayMenu();
        console.error('[update] 拉起更新脚本失败', e);
      }
    }, 500);

    return { ok: true };
  } catch (e) {
    update.downloading = false;
    update.percent = null;
    update.error = e.message || String(e);
    pushUpdate();
    updateTrayMenu();
    return { ok: false, error: update.error };
  }
}

/* ---------------- 刷新 ---------------- */

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 禅道返回的描述/评论是富文本 HTML，挂件里直接渲染前做一遍清洗 + 相对路径补全 */
function sanitizeHtml(html, baseUrl) {
  if (!html) return '';
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let s = String(html);
  // 干掉能执行/外联的标签
  s = s.replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*(script|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '');
  // 行内事件、javascript: 伪协议
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  s = s.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2');
  // 相对地址补成绝对地址（图片/附件靠这个才能显示）
  if (base) {
    s = s.replace(/(src|href)\s*=\s*(["'])(?!https?:|data:|mailto:|#|\/\/)([^"']*)\2/gi, (m, attr, q, val) => {
      const abs = val.startsWith('/') ? base + val : `${base}/${val}`;
      return `${attr}=${q}${abs}${q}`;
    });
  }
  return s;
}

/* ---------------- 描述图片内联 ---------------- */

const MAX_INLINE_IMAGES = 12;
const imgCache = new Map(); // fileID -> data URL（同一张图不重复拉）

function fileIdOf(src) {
  const m = String(src || '').match(/[?&]fileID=(\d+)/i) || String(src || '').match(/file-read-(\d+)\./i);
  return m ? m[1] : null;
}

/** 把描述里 <img> 的禅道文件地址换成 data URL，挂件里就能直接看到图了 */
async function inlineDescImages(html) {
  if (!html || !/fileID=|file-read-/i.test(html)) return html;

  const tags = html.match(/<img\b[^>]*>/gi) || [];
  const ids = [];
  for (const tag of tags) {
    const s = tag.match(/src\s*=\s*["']([^"']+)["']/i);
    const id = s && fileIdOf(s[1]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return html;

  await Promise.all(
    ids.slice(0, MAX_INLINE_IMAGES).map(async (id) => {
      const key = `${config.baseUrl}|${id}`;
      if (imgCache.has(key)) return;
      try {
        const data = await client.fetchFileDataUrl(id);
        if (data) imgCache.set(key, data);
      } catch {
        /* 单张失败不影响别的 */
      }
    })
  );

  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const s = tag.match(/src\s*=\s*["']([^"']+)["']/i);
    if (!s) return tag;
    const id = fileIdOf(s[1]);
    const data = id && imgCache.get(`${config.baseUrl}|${id}`);
    if (!data) return tag;
    const orig = s[1].replace(/"/g, '&quot;');
    return tag.replace(s[1], data).replace(/^<img/i, `<img data-orig="${orig}"`);
  });
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
  floatingBall?.setDisplayMode(config.displayMode);
  floatingBall?.updatePreview(config, state.items);
  updateTrayMenu();
}

async function doRefresh(reason = 'timer') {
  if (refreshing) return state;

  // 调试：假数据
  if (process.argv.includes('--mock')) {
    const { MOCK_ITEMS } = require('./mock');
    state = { ok: true, items: MOCK_ITEMS, at: Date.now(), error: null, strategy: 'mock', needSetup: false };
    pushState();
    return state;
  }

  if (!client.configured) {
    state = { ok: false, items: [], at: 0, error: '还没配置禅道地址和账号', needSetup: true };
    pushState();
    return state;
  }
  refreshing = true;
  try {
    // 任务和缺陷走两套接口，各拉各的；一边挂了另一边照常显示
    const [tRes, bRes] = await Promise.allSettled([client.fetchMyTasks(), client.fetchMyBugs()]);
    const taskOk = tRes.status === 'fulfilled';
    const bugOk = bRes.status === 'fulfilled';
    if (!taskOk && !bugOk) throw tRes.reason;

    const items = [
      ...(taskOk ? tRes.value.items : []),
      ...(bugOk ? bRes.value.items : []),
    ];
    const bugWarn = bugOk ? null : (bRes.reason && bRes.reason.message) || '缺陷拉取失败';

    state = {
      ok: true,
      items,
      at: Date.now(),
      error: null,
      strategy: taskOk ? tRes.value.strategy : 'bugs-only',
      execCount: taskOk ? tRes.value.execCount : 0,
      taskCount: taskOk ? tRes.value.items.length : 0,
      bugCount: bugOk ? bRes.value.items.length : 0,
      bugWarn,
      bugTruncated: bugOk ? Boolean(bRes.value.truncated) : false,
      needSetup: false,
    };
  } catch (e) {
    state = {
      ok: false,
      items: state.items || [],
      at: state.at,
      error: e && e.message ? e.message : String(e),
      stale: true,
      needSetup: false,
      errorAt: Date.now(),
    };
  } finally {
    refreshing = false;
  }
  pushState();
  return state;
}

function schedule() {
  clearInterval(timer);
  const ms = Math.max(30, Number(config.intervalSec) || 180) * 1000;
  timer = setInterval(() => doRefresh('timer'), ms);
}

function showAndFocus() {
  if (!win) return createWindow();
  if (floatingBall) floatingBall.showPanel(true);
  else {
    win.show();
    win.focus();
  }
  syncWindowPin();
}

/* ---------------- IPC ---------------- */

function detailFiles(detail) {
  // 现场接口：无附件为 []，有附件为按文件 ID 索引的对象。
  return Object.values(detail.files || {}).map(f => ({ id: Number(f.id), name: String(f.title) }));
}

function attachmentFilename(title) {
  let name = title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '');
  if (!name) name = '附件';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = '_' + name;
  const extension = path.extname(name);
  return name.slice(0, name.length - extension.length).slice(0, 160) + extension.slice(0, 20);
}

async function openAttachment({ kind, id, fileId } = {}) {
  if (!['task', 'bug'].includes(kind) || ![id, fileId].every(n => Number.isSafeInteger(n) && n > 0)) {
    return { ok: false, error: '附件请求无效' };
  }
  let directory;
  let opened = false;
  let stage = '读取附件信息';
  try {
    // 回查所属详情和权限；不信任前端提供的路径、文件名或下载地址。
    const detail = await (kind === 'task' ? client.getTaskDetail(id) : client.getBugDetail(id));
    const file = detailFiles(detail).find(f => f.id === fileId);
    if (!file) return { ok: false, error: '此任务或缺陷已无该附件，请刷新详情' };

    stage = '保存附件';
    directory = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'zentao-attachment-'));
    const destination = path.join(directory, attachmentFilename(file.name));
    stage = '下载附件';
    await client.downloadFile(file.id, destination);
    stage = '本地打开附件';
    const error = await shell.openPath(destination);
    if (error) throw new Error('System could not open attachment');
    opened = true;
    return { ok: true };
  } catch (e) {
    const hint = e.status === 403 ? '无权限'
      : e.status === 401 ? '登录失效，请检查账号配置'
      : e.status ? 'HTTP ' + e.status
      : stage === '本地打开附件' ? '请检查系统默认程序及文件访问权限'
      : stage === '保存附件' ? '请检查磁盘空间及目录权限'
      : stage === '下载附件' && e instanceof ZentaoError ? e.message
      : stage === '下载附件' ? '请检查网络、登录状态、磁盘空间及目录权限'
      : '请检查网络及登录状态';
    return { ok: false, error: stage + '失败：' + hint };
  } finally {
    if (directory && !opened) await fs.promises.rm(directory, { recursive: true, force: true });
  }
}


function wireIpc() {
  ipcMain.handle('state:get', () => ({
    state,
    config: publicConfig(),
    appVersion: app.getVersion(),
    update: publicUpdate(),
  }));

  ipcMain.handle('update:check', () => checkUpdate());
  ipcMain.handle('update:install', () => installUpdate());
  ipcMain.handle('update:state', () => publicUpdate());
  ipcMain.handle('update:open-release', () => {
    shell.openExternal('https://github.com/yayalee-last/zenway-dashboard-tool/releases');
  });

  ipcMain.handle('zentao:refresh', async () => {
    await doRefresh('manual');
    return { state, config: publicConfig() };
  });

  ipcMain.handle('config:test', async (_e, patch) => {
    const probe = new ZentaoClient({ ...config, ...patch });
    try {
      const r = await probe.selfTest();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message || String(e), status: e.status || 0 };
    }
  });

  ipcMain.handle('config:save', async (_e, patch) => {
    const autoUpdateWasEnabled = config.autoUpdate !== false;
    if (patch && typeof patch.baseUrl === 'string') patch.baseUrl = normalizeBaseUrl(patch.baseUrl);
    saveConfig(patch);
    client.applyConfig(config);
    if ('autoLaunch' in patch) app.setLoginItemSettings({ openAtLogin: Boolean(patch.autoLaunch), args: ['--background'] });
    syncWindowPin();
    floatingBall?.setDisplayMode(config.displayMode);
    floatingBall?.updatePreview(config, state.items);
    schedule();
    if (autoUpdateWasEnabled !== (config.autoUpdate !== false)) scheduleUpdateChecks(0);
    client.projectCache = null;
    client.execCache = null;
    client.productCache = null;
    const s = await doRefresh('config');
    return { state: s, config: publicConfig() };
  });

  ipcMain.handle('open:external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('attachment:open', (_e, payload) => openAttachment(payload));

  ipcMain.handle('task:detail', async (_e, id) => {
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: '任务 ID 无效' };
    try {
      const d = await client.getTaskDetail(id);
      if (!d || Number(d.id) !== id) throw new Error('任务详情不可用，请在禅道网页核对');
      const kids = taskChildren(d);
      const allKids = kids.children;
      const mine = isMine(d, config.account);
      return {
        ok: true,
        task: {
          id: Number(d.id),
          name: d.name || '',
          status: d.status || '',
          pri: Number(d.pri) || 0,
          deadline: d.deadline || null,
          left: Number(d.left) || 0,
          consumed: Number(d.consumed) || 0,
          estimate: Number(d.estimate) || 0,
          progress: Number(d.progress) || 0,
          realStarted: d.realStarted || null,
          estStarted: d.estStarted || null,
          finishedDate: d.finishedDate || null,
          openedDate: d.openedDate || null,
          openedBy: (d.openedBy && (d.openedBy.realname || d.openedBy.account)) || '',
          assignedRealname: assigneeName(d),
          isMine: mine,
          readOnly: !mine,
          executionName: d.executionName || '',
          moduleTitle: d.moduleTitle || '',
          storyID: Number(d.storyID || d.story) || 0,
          storyTitle: d.storyTitle || '',
          parent: Number(d.parent) || 0,
          isParent: isParentTask(d, kids) ? 1 : 0,
          parentName: d.parentName || '',
          parentUrl: Number(d.parent) > 0 ? client.taskUrl(Number(d.parent)) : null,
          url: client.taskUrl(Number(d.id)),
          operateMenu: d.operateMenu || [],
          selfAccount: config.account || '',
          childrenState: kids.state,
          childrenTotal: kids.state === 'supplied' ? allKids.length : null,
          othersCount: allKids.filter(c => !isMine(c, config.account)).length,
          desc: await inlineDescImages(sanitizeHtml(d.desc, config.baseUrl)),
          files: detailFiles(d),
          history: (d.actions || [])
            .filter((a) => a && a.action !== 'mentioned')
            .slice(-10)
            .reverse()
            .map((a) => ({
              actor: a.actor || '',
              date: a.date || '',
              action: a.action || '',
              // 禅道的 desc 自带 "2026-10-24 14:00:45, " 前缀，时间已经在旁边显示了
              text: sanitizeHtml(a.desc || '', config.baseUrl)
                .replace(/<[^>]+>/g, '')
                .replace(/^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2},?\s*/, '')
                .replace(/\s+/g, ' ')
                .trim(),
              comment: sanitizeHtml(a.comment || '', config.baseUrl),
            })),
          children: allKids.map((c) => ({
            id: Number(c.id),
            name: c.name || '',
            status: c.status || '',
            pri: Number(c.pri) || 0,
            account: accountOf(c),
            realname: assigneeName(c),
            isMine: isMine(c, config.account),
            readOnly: !isMine(c, config.account),
            left: Number(c.left) || 0,
            url: client.taskUrl(c.id),
          })),
        },
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('task:action', async (event, request = {}) => {
    if (!win || event?.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      return { ok: false, error: '任务操作来源无效' };
    }
    const { id, action, payload } = request || {};
    if (!Number.isSafeInteger(id) || id <= 0 || !['start', 'finish', 'close'].includes(action)) {
      return { ok: false, error: '任务操作请求无效' };
    }
    try {
      // 展示可见子任务不授予修改权。不要信任 renderer 的 isMine/readOnly，
      // 每次写入前回查当前负责人；读取失败或身份不确定时不执行写操作。
      const current = await client.getTaskDetail(id);
      if (!current || Number(current.id) !== id || !isMine(current, config.account)) {
        return { ok: false, error: '仅可操作当前明确指派给自己的任务；参考任务请在禅道网页处理' };
      }
      if (action === 'start') await client.startTask(id, payload || {});
      else if (action === 'finish') await client.finishTask(id, payload || {});
      else if (action === 'close') await client.closeTask(id, payload && payload.closedReason);
      else throw new Error(`不支持的操作：${action}`);

      // 禅道对不存在的任务也会回 200 null，必须回查状态才知道有没有真生效
      await new Promise((r) => setTimeout(r, 400));
      let actual = null;
      try {
        const d = await client.getTaskDetail(id);
        actual = d.status || null;
      } catch {
        /* 查不到就跳过校验 */
      }

      await doRefresh('action');

      const expect = { start: 'doing', finish: 'done', close: 'closed' }[action];
      if (actual && expect && actual !== expect) {
        return { ok: false, error: `没生效，任务状态还是「${actual}」`, state };
      }
      return { ok: true, state, status: actual };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('bug:detail', async (_e, id) => {
    if (process.argv.includes('--mock')) {
      const { MOCK_BUG_DETAIL } = require('./mock');
      const n = Number(id) || MOCK_BUG_DETAIL.id;
      const base = { ...MOCK_BUG_DETAIL, id: n };
      // 1048 用来演示「已解决 → 关闭」那一套
      if (n === 1048) {
        Object.assign(base, {
          status: 'resolved',
          statusName: '已解决',
          resolution: 'fixed',
          resolvedBuild: 'trunk',
          resolvedBy: '杨成',
          resolvedDate: '2026-10-26 14:10:00',
        });
      }
      return { ok: true, bug: base };
    }
    try {
      const d = await client.getBugDetail(id);
      const name = (o) => (o && (o.realname || o.account)) || '';
      const files = detailFiles(d);

      return {
        ok: true,
        bug: {
          id: Number(d.id),
          title: d.title || '',
          status: d.status || '',
          statusName: d.statusName || '',
          severity: Number(d.severity) || 0,
          pri: Number(d.pri) || 0,
          type: d.type || '',
          productName: d.productName || '',
          moduleTitle: d.moduleTitle || '',
          projectName: d.projectName || '',
          executionName: d.executionName || '',
          openedBy: name(d.openedBy),
          openedDate: d.openedDate || null,
          assignedTo: name(d.assignedTo),
          assignedDate: d.assignedDate || null,
          deadline: d.deadline || null,
          resolvedBy: name(d.resolvedBy),
          resolution: d.resolution || '',
          resolvedBuild: (d.resolvedBuild && (d.resolvedBuild.title || d.resolvedBuild)) || '',
          resolvedDate: d.resolvedDate || null,
          closedDate: d.closedDate || null,
          activatedCount: Number(d.activatedCount) || 0,
          confirmed: Number(d.confirmed) || 0,
          storyTitle: d.storyTitle || '',
          taskName: d.taskName || '',
          url: client.bugUrl(Number(d.id)),
          steps: await inlineDescImages(sanitizeHtml(d.steps, config.baseUrl)),
          files,
          history: (d.actions || [])
            .filter((a) => a && a.action !== 'mentioned')
            .slice(-12)
            .reverse()
            .map((a) => ({
              actor: a.actor || '',
              date: a.date || '',
              action: a.action || '',
              text: sanitizeHtml(a.desc || '', config.baseUrl)
                .replace(/<[^>]+>/g, '')
                .replace(/^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2},?\s*/, '')
                .replace(/\s+/g, ' ')
                .trim(),
              comment: sanitizeHtml(a.comment || '', config.baseUrl),
            })),
        },
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('bug:action', async (_e, { id, action, payload } = {}) => {
    if (process.argv.includes('--mock')) {
      const fake = (process.argv.find((a) => a.startsWith('--mock-bug-fail')) || '').includes('fail');
      if (fake) return { ok: false, error: '「解决方案」不能为空（mock）' };
      return { ok: true, state, status: action === 'resolve' ? 'resolved' : 'closed' };
    }
    try {
      if (action === 'resolve') await client.resolveBug(id, payload || {});
      else if (action === 'close') await client.closeBug(id, payload && payload.comment);
      else throw new Error(`不支持的操作：${action}`);

      // 跟任务一样：禅道对不生效的写操作也可能回 200，必须回查状态
      await new Promise((r) => setTimeout(r, 400));
      let actual = null;
      try {
        actual = (await client.getBugDetail(id)).status || null;
      } catch {
        /* 查不到就跳过校验 */
      }

      await doRefresh('bug-action');

      const expect = { resolve: 'resolved', close: 'closed' }[action];
      if (actual && expect && actual !== expect) {
        return {
          ok: false,
          error: `禅道没真改（状态还是「${actual}」），多半是解决方案/解决版本不对，换个版本号再试`,
          state,
        };
      }
      return { ok: true, state, status: actual };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('win:minimize', () => win?.hide());
  ipcMain.handle('win:resize', (_e, h) => {
    if (!win || !Number.isFinite(h)) return;
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const [w] = win.getSize();
    const [x, y] = win.getPosition();
    const target = Math.max(200, Math.min(area.height - 80, Math.round(h)));
    if (Math.abs(target - win.getSize()[1]) < 4) return;
    // 顶边固定，向右下收缩
    win.setBounds({ x, y, width: w, height: target });
  });
  ipcMain.handle('win:close', () => {
    app.__quitting = true;
    app.quit();
  });
  ipcMain.handle('win:toggle-pin', () => {
    saveConfig({ alwaysOnTop: !config.alwaysOnTop });
    syncWindowPin();
    updateTrayMenu();
    return config.alwaysOnTop;
  });
}

/* ---------------- 启动 ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showAndFocus());

  app.whenReady().then(() => {
    loadConfig();
    client = new ZentaoClient(config);
    updater = new Updater({
      currentVersion: app.getVersion(),
      stateDir: STATE_DIR,
      appDir: path.dirname(process.execPath),
      exeName: path.basename(process.execPath),
      apiUrl: process.env.ZT_UPDATE_API || config.updateApi || undefined,
    });
    wireIpc();
    createWindow();
    createTray();
    schedule();
    setTimeout(() => doRefresh('boot'), 400);

    scheduleUpdateChecks();

  });

  app.on('window-all-closed', () => {
    /* 常驻托盘，不退出 */
  });

  app.on('before-quit', () => {
    app.__quitting = true;
    clearInterval(timer);
    clearTimeout(updateTimer);
    floatingBall?.destroy();
  });
}
