#!/usr/bin/env node
/**
 * 获取 Windows x64 版 Electron 运行时目录
 *
 * 为什么不能直接用 node_modules/electron/dist：
 *   npm install 装的是「当前平台」的运行时。在 Linux CI 上构建 Windows 包时，
 *   那里面是 linux 二进制，没有 electron.exe。
 *
 * 取用顺序（命中即返回，不联网）：
 *   1. node_modules/electron/dist 里有 electron.exe  → 说明本机就是 Windows，直接用
 *   2. node_modules/.cache/electron-win32-x64/<ver>/  → 之前下载过，复用
 *   3. 从镜像下载 electron-v<ver>-win32-x64.zip 并解压到 2 的位置
 *
 * 镜像可用环境变量 ELECTRON_MIRROR 覆盖，例如：
 *   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

export const ELECTRON_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')
).version;

const CACHE_ROOT = path.join(ROOT, 'node_modules', '.cache', 'electron-win32-x64');

const MIRRORS = [
  process.env.ELECTRON_MIRROR,
  'https://npmmirror.com/mirrors/electron/',
  'https://github.com/electron/electron/releases/download/',
].filter(Boolean);

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

function hasExe(dir) {
  return fs.existsSync(path.join(dir, 'electron.exe'));
}

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  let done = 0;
  let lastPct = -1;

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    if (!total) return;
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      process.stdout.write(`  ${pct}%  ${mb(done)} / ${mb(total)}\n`);
    }
  });

  await pipeline(body, fs.createWriteStream(dest));
  return done;
}

/**
 * @returns {Promise<string>} 含 electron.exe 的目录绝对路径
 */
export async function ensureWin32Runtime() {
  // 1. 本机就是 Windows，node_modules 里现成
  const local = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (hasExe(local)) {
    console.log(`Electron 运行时：本机 node_modules（${ELECTRON_VERSION}）`);
    return local;
  }

  // 2. 缓存
  const cached = path.join(CACHE_ROOT, ELECTRON_VERSION);
  if (hasExe(cached)) {
    console.log(`Electron 运行时：缓存命中（${ELECTRON_VERSION}）`);
    return cached;
  }

  // 3. 下载
  const file = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
  const zipPath = path.join(CACHE_ROOT, `${ELECTRON_VERSION}.zip`);
  fs.mkdirSync(CACHE_ROOT, { recursive: true });

  let lastErr = null;
  let ok = false;
  for (const base of MIRRORS) {
    const url = base.replace(/\/?$/, '/') + ELECTRON_VERSION + '/' + file;
    console.log(`下载 ${file}`);
    console.log(`  来源 ${base}`);
    try {
      const bytes = await downloadTo(url, zipPath);
      console.log(`  完成 ${mb(bytes)}`);
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      console.log(`  失败：${e.message}`);
    }
  }
  if (!ok) {
    throw new Error(
      `所有镜像都下不到 ${file}\n  最后错误：${lastErr && lastErr.message}\n  可设 ELECTRON_MIRROR 指向内网镜像后重试`
    );
  }

  console.log('解压中…');
  const extractZip = (await import('extract-zip')).default;
  fs.rmSync(cached, { recursive: true, force: true });
  await extractZip(zipPath, { dir: cached });
  fs.rmSync(zipPath, { force: true });

  if (!hasExe(cached)) {
    throw new Error(`解压后没找到 electron.exe：${cached}`);
  }
  console.log(`Electron 运行时：已下载（${ELECTRON_VERSION}）`);
  return cached;
}
