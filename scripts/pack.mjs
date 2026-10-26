#!/usr/bin/env node
/**
 * 打包成免安装绿色版（Windows x64）
 *
 * 用法：npm run pack
 * 产出：release/ZentaoWidget-win32-x64/   ← 双击 ZentaoWidget.exe 直接跑
 *       release/ZentaoWidget-win32-x64.zip ← 发给同事解压即用
 *
 * 原理：直接复用 node_modules/electron/dist 里现成的运行时，把源码塞进
 * resources/app，再把 electron.exe 改名。不联网、不下载、不依赖打包工具链。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const RELEASE = path.join(ROOT, 'release');

const APP_NAME = 'ZentaoWidget';
const OUT = path.join(RELEASE, `${APP_NAME}-win32-x64`);

/* ---------- 前置检查 ---------- */

if (!fs.existsSync(path.join(DIST, 'electron.exe'))) {
  console.error('找不到 Electron 运行时：' + DIST);
  console.error('先执行 npm install，若仍缺失再补跑：');
  console.error('  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/');
  console.error('  node node_modules/electron/install.js');
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'assets', 'icon.png'))) {
  console.log('图标缺失，先生成…');
  execFileSync(process.execPath, [path.join(HERE, 'make-icon.mjs')], { stdio: 'inherit' });
}

/* ---------- 清理 ---------- */

fs.rmSync(RELEASE, { recursive: true, force: true });
fs.mkdirSync(RELEASE, { recursive: true });

/* ---------- 1. 复制运行时 ---------- */

console.log('复制 Electron 运行时…');
fs.cpSync(DIST, OUT, { recursive: true });

// 官方默认应用，留着会干扰启动时对 app 目录的查找
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

/* ---------- 2. 放入应用代码 ---------- */

const APP_DIR = path.join(OUT, 'resources', 'app');
fs.mkdirSync(APP_DIR, { recursive: true });

for (const entry of ['electron', 'renderer', 'assets', 'zentao.config.example.json']) {
  const from = path.join(ROOT, entry);
  if (fs.existsSync(from)) {
    fs.cpSync(from, path.join(APP_DIR, entry), { recursive: true });
  }
}

// 打包后的 package.json 只留运行时必需的字段
const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const appPkg = {
  name: src.name,
  version: src.version,
  description: src.description,
  main: src.main,
};
fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify(appPkg, null, 2));

/* ---------- 3. 改名 ---------- */

const exeFrom = path.join(OUT, 'electron.exe');
const exeTo = path.join(OUT, `${APP_NAME}.exe`);
fs.renameSync(exeFrom, exeTo);

/* ---------- 3.5 写入 exe 图标与版本信息 ---------- */

const ICO = path.join(ROOT, 'assets', 'icon.ico');
if (fs.existsSync(path.join(ROOT, 'node_modules', 'rcedit')) && fs.existsSync(ICO)) {
  console.log('写入 exe 图标与版本信息…');
  try {
    const mod = await import('rcedit');
    const rcedit = mod.rcedit || mod.default;
    await rcedit(exeTo, {
      icon: ICO,
      'file-version': src.version,
      'product-version': src.version,
      'version-string': {
        FileDescription: '禅道桌面待办挂件',
        ProductName: '禅道挂件',
        OriginalFilename: `${APP_NAME}.exe`,
        CompanyName: 'work_ai_tools',
        LegalCopyright: '',
      },
    });
  } catch (e) {
    console.log('  图标写入失败（不影响运行）：' + (e.message || e));
  }
} else {
  console.log('跳过图标写入（未安装 rcedit 或缺少 assets/icon.ico）');
}

/* ---------- 4. 统计 ---------- */

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const total = dirSize(OUT);

console.log('');
console.log(`输出目录  ${OUT}`);
console.log(`可执行    ${path.basename(exeTo)}`);
console.log(`体积      ${mb(total)}`);

/* ---------- 5. 压缩（Windows 才做） ---------- */

if (process.platform === 'win32') {
  const zip = path.join(RELEASE, `${APP_NAME}-win32-x64.zip`);
  console.log('压缩中…（约需半分钟）');
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`,
      ],
      { stdio: 'ignore' }
    );
    console.log(`压缩包    ${zip}  ${mb(fs.statSync(zip).size)}`);
  } catch {
    console.log('压缩失败（不影响目录版使用），可手动右键压缩 release 目录');
  }
}

console.log('');
console.log('完成。双击 ' + path.join(OUT, `${APP_NAME}.exe`) + ' 即可运行。');
