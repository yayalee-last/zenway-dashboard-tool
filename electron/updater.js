'use strict';

/**
 * 自动更新（GitHub Releases）
 *
 * 流程：
 *   1. 拉 releases/latest，比对 tag 与本机版本
 *   2. 下载 zip 附件到 userData/updates/
 *   3. 用 Expand-Archive 解压到 updates/extract-<ver>/
 *   4. 写一个 cmd 助手：等本进程退出 → robocopy 覆盖 → 重新拉起
 *   5. 本进程退出，cmd 接管
 *
 * 之所以要 cmd 中转：Windows 上正在运行的 exe 不能被覆盖，
 * 只能先退出自己，再让外部进程替换文件。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const DEFAULT_API =
  'https://api.github.com/repos/yayalee-last/zenway-dashboard-tool/releases/latest';

const UA = 'zentao-widget-updater';

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
    this.appDir = appDir;
    this.exeName = exeName || path.basename(process.execPath);
    this.updateDir = path.join(stateDir, 'updates');
  }

  /* --- 1. 查询 --- */

  async check({ timeoutMs = 12000 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(this.apiUrl, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ac.signal,
      });

      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* 非 JSON，下面按状态码给提示 */
      }

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
      // 优先选 win32-x64 的 zip
      const pick =
        assets.find((a) => /\.zip$/i.test(a.name || '') && /win32|windows/i.test(a.name || '')) ||
        assets.find((a) => /\.zip$/i.test(a.name || '')) ||
        null;

      const hasUpdate = cmpVer(latest, this.current) > 0;

      return {
        ok: true,
        current: this.current,
        latest,
        hasUpdate,
        notes: String(body.body || '').slice(0, 4000),
        publishedAt: body.published_at || body.created_at || null,
        asset: pick ? { name: pick.name, url: pick.browser_download_url, size: Number(pick.size) || 0 } : null,
        assetMissing: hasUpdate && !pick,
      };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, error: '检查更新超时（网络不通？）' };
      return { ok: false, error: `检查更新失败：${e.message || e}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /* --- 2. 下载 --- */

  async download(asset, onProgress) {
    if (!asset || !asset.url) throw new Error('发行版里没有可下载的压缩包');
    fs.mkdirSync(this.updateDir, { recursive: true });

    const safeName = String(asset.name || 'update.zip').replace(/[^\w.\-]+/g, '_');
    const zipPath = path.join(this.updateDir, safeName);
    const partPath = zipPath + '.part';

    const res = await fetch(asset.url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const chunks = [];
    let received = 0;
    let lastEmit = 0;

    for await (const chunk of res.body) {
      chunks.push(chunk);
      received += chunk.length;
      const now = Date.now();
      if (onProgress && (now - lastEmit > 120 || (total && received >= total))) {
        lastEmit = now;
        onProgress({ received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : null });
      }
    }

    const buf = Buffer.concat(chunks);
    if (total && Math.abs(buf.length - total) > 1024) {
      throw new Error(`下载不完整：收到 ${buf.length} 字节，应为 ${total}`);
    }

    fs.writeFileSync(partPath, buf);
    fs.renameSync(partPath, zipPath);
    if (onProgress) onProgress({ received: buf.length, total: buf.length, percent: 100 });
    return { zipPath, bytes: buf.length };
  }

  /* --- 3. 解压 + 交给 cmd 助手 --- */

  async install(zipPath, version) {
    const extractDir = path.join(this.updateDir, `extract-${String(version).replace(/[^\w.\-]+/g, '_')}`);
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

    if (!fs.existsSync(path.join(srcRoot, this.exeName))) {
      throw new Error(`解压后没找到 ${this.exeName}，包结构不对`);
    }

    const script = this.writeApplyScript(srcRoot, this.appDir, this.exeName);
    return { script, srcRoot };
  }

  /**
   * 生成 cmd 助手。
   *
   * 脚本内容保持纯 ASCII，路径不写进文件，而是通过环境变量传进去
   * （CreateProcess 走 UTF-16，不会因为安装路径带中文或空格而乱码）。
   */
  writeApplyScript(srcRoot, dstRoot, exeName) {
    const dir = path.join(os.tmpdir(), 'zentao-widget-update');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'apply-update.cmd');

    const lines = [
      '@echo off',
      'setlocal enableextensions',
      '',
      ':wait',
      'tasklist /FI "IMAGENAME eq %ZT_EXE%" 2>nul | find /I "%ZT_EXE%" >nul',
      'if not errorlevel 1 (',
      '  timeout /t 1 /nobreak >nul',
      '  goto wait',
      ')',
      '',
      'robocopy "%ZT_SRC%" "%ZT_DST%" /MIR /NFL /NDL /NJH /NJS /NC /NS /NP >nul',
      'if exist "%ZT_DST%\\%ZT_EXE%" start "" "%ZT_DST%\\%ZT_EXE%"',
      '(goto) 2>nul & del "%~f0"',
      '',
    ];

    fs.writeFileSync(file, lines.join('\r\n'), 'latin1');
    return { file, env: { ZT_SRC: srcRoot, ZT_DST: dstRoot, ZT_EXE: exeName } };
  }

  /** 拉起助手脚本并让本进程退出 */
  launchApply(script) {
    const child = spawn('cmd.exe', ['/c', script.file], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...script.env },
    });
    child.unref();
    return true;
  }
}

module.exports = { Updater, cmpVer, parseVer, DEFAULT_API };
