'use strict';

/**
 * 自动更新（GitHub Releases）
 *
 * 流程：
 *   1. 拉 releases/latest，比对 tag 与本机版本
 *   2. 下载 zip 附件到 userData/updates/
 *   3. 用 Expand-Archive 解压到 updates/extract-<ver>/
 *   4. 后台助手等待本次进程退出，再替换应用并重新启动
 *   5. 替换失败时恢复旧版，等待超过 30 秒则停止
 *
 * Windows 上正在运行的 exe 不能被覆盖，
 * 只能先退出自己，再让外部进程替换文件。
 */

const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { APP_ARCHIVE, UPDATE_MANIFEST, UPDATE_SCHEMA } = require('./update-format');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const DEFAULT_API =
  'https://api.github.com/repos/yayalee-last/zenway-dashboard-tool/releases/latest';
const UPDATE_PROXY = 'https://gh-proxy.com/';

const UA = 'zentao-widget-updater';

// 仅为本应用公开的版本接口和发行附件提供公共代理回退。
function proxyUpdateUrl(url) {
  let target;
  try { target = new URL(url); } catch { return null; }
  if (target.username || target.password || target.search || target.hash) return null;
  if (target.href === DEFAULT_API) return UPDATE_PROXY + target.href;
  if (target.origin !== 'https://github.com' ||
      !/^\/yayalee-last\/zenway-dashboard-tool\/releases\/download\/[^/]+\/(?:ZentaoWidget-app\.zip|ZentaoWidget-win32-x64\.zip|ZentaoWidget-update\.json)$/.test(target.pathname)) return null;
  return UPDATE_PROXY + target.href;
}

async function fetchUpdate(url, { signal, timeoutMs, headers }, readResponse) {
  const proxy = proxyUpdateUrl(url);
  const routes = proxy ? [url, proxy] : [url];
  for (let index = 0; index < routes.length; index++) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(routes[index], { headers, signal: requestSignal, redirect: 'follow' });
      if (index + 1 < routes.length &&
          ([403, 408, 429].includes(response.status) || response.status >= 500)) {
        await response.body?.cancel();
        continue;
      }
      timer.refresh();
      return await readResponse(response, { signal: requestSignal, timer });
    } catch (error) {
      signal?.throwIfAborted();
      if (index + 1 === routes.length) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readUpdateJson(response) {
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    if (response.ok) throw new Error('更新服务未返回有效的 JSON');
  }
  return { ok: response.ok, status: response.status, body };
}


function releaseAsset(asset, kind = 'full', sha256) {
  if (!asset) return null;
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '');
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: Number(asset.size) || 0,
    kind,
    sha256: sha256 || (digest ? digest[1].toLowerCase() : undefined),
  };
}

/* ---------------- 版本号 ---------------- */

/** "v0.2.1" / "0.2" → [0,2,1]，解析不了的段按 0 算 */
function parseVer(v) {
  const m = String(v || '')
    .trim()
    .replace(/^v/i, '')
    .match(/\d+(?:\.\d+)*/);
  if (!m) return [0];
  return m[0].split('.').map((n) => Number(n) || 0);
}

/** a > b 返回 1，相等 0，小于 -1 */
function cmpVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const p = x[i] || 0;
    const q = y[i] || 0;
    if (p > q) return 1;
    if (p < q) return -1;
  }
  return 0;
}

/* ---------------- 工具 ---------------- */

function psQuote(p) {
  // PowerShell 单引号字符串：内部单引号翻倍即可，$ 和反引号都失去特殊含义
  return `'${String(p).replace(/'/g, "''")}'`;
}

function runPowerShell(command, timeout = 180000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
        resolve(String(stdout || '').trim());
      }
    );
  });
}

/* ---------------- 主体 ---------------- */

class Updater {
  constructor({ currentVersion, apiUrl, stateDir, appDir, exeName }) {
    this.current = currentVersion || '0.0.0';
    this.apiUrl = apiUrl || DEFAULT_API;
    this.stateDir = stateDir;
    this.appDir = path.resolve(appDir);
    this.exeName = exeName || path.basename(process.execPath);
    this.updateDir = path.resolve(stateDir, 'updates');
  }

  /* --- 1. 查询 --- */

  async check({ timeoutMs = 12000 } = {}) {
    try {
      const res = await fetchUpdate(this.apiUrl, {
        headers: { 'User-Agent': UA, Accept: 'application/json' }, timeoutMs,
      }, readUpdateJson);
      const { body } = res;

      if (!res.ok) {
        const msg = body && (body.message || body.error);
        if (res.status === 404 || /Not Found/i.test(msg || '')) {
          return {
            ok: false,
            error: '仓库里还没有发布过 Release（或仓库仍是私有）。发一次带 zip 的发行版，客户端才收得到更新。',
            hint: 'private-or-empty',
          };
        }
        if (res.status === 403 || res.status === 429) {
          return { ok: false, error: 'GitHub 接口调用太频繁，过一会儿再试。', hint: 'rate-limit' };
        }
        return { ok: false, error: `检查更新失败：HTTP ${res.status}` };
      }

      const latest = String(body.tag_name || body.name || '').trim();
      if (!latest) return { ok: false, error: '发行版缺少版本号标签' };

      const assets = Array.isArray(body.assets) ? body.assets : [];
      const full = assets.find((a) => a.name === 'ZentaoWidget-win32-x64.zip') ||
        assets.find((a) => /\.zip$/i.test(a.name || '') && /win32|windows/i.test(a.name || '')) ||
        assets.find((a) => /\.zip$/i.test(a.name || '') && a.name !== APP_ARCHIVE);
      let pick = releaseAsset(full);
      const hasUpdate = cmpVer(latest, this.current) > 0;
      const metadata = assets.find((a) => a.name === UPDATE_MANIFEST);

      if (hasUpdate && metadata && process.versions.electron) {
        try {
          const response = await fetchUpdate(metadata.browser_download_url, {
            headers: { 'User-Agent': UA }, timeoutMs,
          }, readUpdateJson);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const manifest = response.body;
          const appAsset = assets.find((a) => a.name === APP_ARCHIVE);
          if (manifest.schemaVersion === UPDATE_SCHEMA &&
              manifest.version === latest.replace(/^v/i, '') &&
              manifest.electronVersion === process.versions.electron &&
              manifest.platform === process.platform && manifest.arch === process.arch &&
              manifest.asset === APP_ARCHIVE && /^[a-f0-9]{64}$/i.test(manifest.sha256 || '') &&
              Number.isSafeInteger(manifest.size) && manifest.size > 0 &&
              appAsset && manifest.size === Number(appAsset.size)) {
            pick = releaseAsset(appAsset, 'app', manifest.sha256.toLowerCase());
          }
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          // 元数据不可用时仍允许使用兼容旧客户端的完整包。
        }
      }

      return {
        ok: true,
        current: this.current,
        latest,
        hasUpdate,
        notes: String(body.body || '').slice(0, 4000),
        publishedAt: body.published_at || body.created_at || null,
        asset: pick,
        assetMissing: hasUpdate && !pick,
      };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, error: '检查更新超时（网络不通？）' };
      return { ok: false, error: `检查更新失败：${e.message || e}` };
    }
  }

  /* --- 2. 下载 --- */

  async download(asset, onProgress, { signal, timeoutMs = 30000 } = {}) {
    if (!asset || !asset.url) throw new Error('发行版里没有可下载的压缩包');
    if (asset.kind === 'app' && !asset.sha256) throw new Error('应用更新包缺少校验信息');
    fs.mkdirSync(this.updateDir, { recursive: true });

    const safeName = String(asset.name || 'update.zip').replace(/[^\w.\-]+/g, '_');
    const zipPath = path.join(this.updateDir, safeName);
    const partPath = zipPath + '.part';
    let downloaded;
    try {
      downloaded = await fetchUpdate(asset.url, {
        headers: { 'User-Agent': UA }, signal, timeoutMs,
      }, async (res, { signal: downloadSignal, timer }) => {
        if (!res.ok) {
          await res.body?.cancel();
          return { error: `下载失败：HTTP ${res.status}` };
        }
        const total = Number(res.headers.get('content-length')) || asset.size || 0;
        const chunks = [];
        let received = 0;
        let lastEmit = 0;

        for await (const chunk of res.body) {
          if (chunk.length) timer.refresh();
          chunks.push(chunk);
          received += chunk.length;
          const now = Date.now();
          if (onProgress && (now - lastEmit > 120 || (total && received >= total))) {
            lastEmit = now;
            onProgress({ received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : null });
          }
        }

        downloadSignal.throwIfAborted();
        const buf = Buffer.concat(chunks);
        if (total && buf.length !== total) {
          throw new Error(`下载不完整：收到 ${buf.length} 字节，应为 ${total}`);
        }
        if (asset.sha256 && createHash('sha256').update(buf).digest('hex') !== asset.sha256) {
          throw new Error('更新包校验失败，请重新下载');
        }
        return { buf };
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === 'AbortError') throw new Error('更新下载超时，请检查网络后重试');
      throw error;
    }

    if (downloaded.error) throw new Error(downloaded.error);
    signal?.throwIfAborted();
    const { buf } = downloaded;
    fs.writeFileSync(partPath, buf);
    fs.renameSync(partPath, zipPath);
    if (onProgress) onProgress({ received: buf.length, total: buf.length, percent: 100 });
    return { zipPath, bytes: buf.length };
  }

  /* --- 3. 解压 + 交给 cmd 助手 --- */

  async install(zipPath, version, asset = {}) {
    const extractDir = path.join(this.updateDir, `extract-${String(version).replace(/[^\w.\-]+/g, '_')}`);
    if (path.dirname(path.resolve(extractDir)) !== this.updateDir) throw new Error('更新解压路径异常');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });

    await runPowerShell(
      `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(extractDir)} -Force`
    );

    // 包内通常是单个顶层目录（ZentaoWidget-win32-x64），剥掉这层
    let srcRoot = extractDir;
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) {
      srcRoot = path.join(extractDir, entries[0].name);
    }

    const appOnly = asset.kind === 'app';
    const packageDir = appOnly ? srcRoot : path.join(srcRoot, 'resources', 'app');
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    if (pkg.name !== 'zentao-widget' || pkg.version !== String(version).replace(/^v/i, '') ||
        pkg.main !== 'electron/main.js' ||
        !fs.existsSync(path.join(packageDir, 'electron', 'main.js')) ||
        !fs.existsSync(path.join(packageDir, 'renderer', 'index.html'))) {
      throw new Error('更新包的应用或版本不匹配');
    }
    if (!appOnly && !fs.existsSync(path.join(srcRoot, this.exeName))) {
      throw new Error(`解压后没找到 ${this.exeName}，包结构不对`);
    }

    const script = this.writeApplyScript(srcRoot, this.appDir, this.exeName, appOnly);
    return { script, srcRoot };
  }

  /** 复制独立的 PowerShell 助手；只等待本次 PID，后台限时替换并支持回滚。 */
  writeApplyScript(srcRoot, dstRoot, exeName, appOnly = false) {
    fs.mkdirSync(this.updateDir, { recursive: true });
    const file = path.join(this.updateDir, `apply-${randomUUID()}.ps1`);
    fs.copyFileSync(path.join(__dirname, 'apply-update.ps1'), file);
    return {
      file,
      env: {
        ZT_SRC: path.resolve(srcRoot),
        ZT_TARGET: appOnly ? path.join(dstRoot, 'resources', 'app') : dstRoot,
        ZT_LAUNCH: path.join(dstRoot, exeName),
        ZT_PARENT_PID: String(process.pid),
        ZT_LOG: path.join(this.updateDir, 'apply-update.log'),
        ZT_READY: file + '.ready',
      },
    };
  }

  async launchApply(script) {
    const wrapper = script.file + '.vbs';
    fs.writeFileSync(wrapper, [
      'Set shell = CreateObject("WScript.Shell")',
      'command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & shell.Environment("PROCESS")("ZT_HELPER_PS") & """"',
      'WScript.Quit shell.Run(command, 0, True)',
    ].join('\r\n'), 'ascii');
    const child = spawn('wscript.exe', ['//B', '//Nologo', wrapper], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(script.file),
      env: { ...process.env, ...script.env, ZT_HELPER_PS: script.file },
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(script.env.ZT_READY)) {
      if (child.exitCode !== null || Date.now() >= deadline) {
        child.kill();
        throw new Error('后台更新助手未能启动');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.unref();
    return true;
  }
}

module.exports = { Updater, cmpVer, parseVer, DEFAULT_API };
