#!/usr/bin/env node
/**
 * 打包成免安装绿色版（Windows x64）
 *
 * 用法：npm run pack
 * 产出：release/ZentaoWidget-win32-x64/   ← 双击 ZentaoWidget.exe 直接跑
 *       release/ZentaoWidget-win32-x64.zip ← 发给同事解压即用
 *
 * 跨平台：Windows / Linux / macOS 都能跑，支持 GitHub Actions 构建。
 *   - 运行时   → scripts/electron-dist.mjs 负责拿（本机有就用，没有就下 win32 包）
 *   - exe 图标 → resedit（纯 JS 改 PE 资源，不需要 wine）
 *   - 压缩     → archiver（不依赖 PowerShell）
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import { ensureWin32Runtime } from './electron-dist.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const RELEASE = path.join(ROOT, 'release');

const APP_NAME = 'ZentaoWidget';
const OUT = path.join(RELEASE, `${APP_NAME}-win32-x64`);
const ZIP = path.join(RELEASE, `${APP_NAME}-win32-x64.zip`);

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const step = (n, msg) => console.log(`[${n}/5] ${msg}`);

/* ---------- 0. 图标 ---------- */

if (!fs.existsSync(path.join(ROOT, 'assets', 'icon.png'))) {
  console.log('图标缺失，先生成…');
  execFileSync(process.execPath, [path.join(HERE, 'make-icon.mjs')], { stdio: 'inherit' });
}

/* ---------- 1. 运行时 ---------- */

step(1, '准备 Electron 运行时');
const DIST = await ensureWin32Runtime();

/* ---------- 2. 清理 ---------- */

step(2, '清理旧产物');
try {
  fs.rmSync(RELEASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch (e) {
  console.error('清不掉旧的 release 目录，通常是有程序正在跑：');
  console.error('  1) 关掉托盘里的「禅道挂件」');
  console.error('  2) 任务管理器里结束 ZentaoWidget.exe');
  console.error(`  原始错误：${e.code || ''} ${e.message || e}`);
  process.exit(1);
}
fs.mkdirSync(RELEASE, { recursive: true });

/* ---------- 3. 复制运行时 + 应用代码 ---------- */

step(3, '复制运行时与应用代码');
fs.cpSync(DIST, OUT, { recursive: true });

// 官方默认应用，留着会干扰启动时对 app 目录的查找
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

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
fs.writeFileSync(
  path.join(APP_DIR, 'package.json'),
  JSON.stringify(
    { name: src.name, version: src.version, description: src.description, main: src.main },
    null,
    2
  )
);

/* ---------- 4. 改名 + 写图标与版本信息 ---------- */

step(4, '写入 exe 图标与版本信息');
const exeFrom = path.join(OUT, 'electron.exe');
const exeTo = path.join(OUT, `${APP_NAME}.exe`);
fs.renameSync(exeFrom, exeTo);

const ICO = path.join(ROOT, 'assets', 'icon.ico');

/**
 * 用 resedit 改 PE 资源：纯 JavaScript，Windows / Linux / macOS 结果一致。
 * 注意 electron.exe 带 Authenticode 签名，解析时必须 ignoreCert，
 * 生成的二进制签名会失效 —— 绿色版本来就没签名，无影响。
 */
async function patchExeRes() {
  const ResEdit = await import('resedit');
  const data = fs.readFileSync(exeTo);
  const exe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // 图标
  if (fs.existsSync(ICO)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ICO));
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    const groupId = groups.length ? groups[0].id : 1;
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      groupId,
      1033,
      iconFile.icons.map((i) => i.data)
    );
  }

  // 版本信息
  const ver = String(src.version).split('.').map((n) => Number(n) || 0);
  while (ver.length < 3) ver.push(0);
  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (viList.length) {
    const vi = viList[0];
    vi.setFileVersion(ver[0], ver[1], ver[2], 0, 1033);
    vi.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        FileDescription: '禅道桌面待办挂件',
        ProductName: '禅道挂件',
        FileVersion: src.version,
        ProductVersion: src.version,
        OriginalFilename: `${APP_NAME}.exe`,
        CompanyName: 'work_ai_tools',
      }
    );
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  const out = Buffer.from(exe.generate());

  // 先写临时文件再替换，避免读自己写自己
  const tmp = exeTo + '.tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, exeTo);
}

try {
  await patchExeRes();
  console.log(`  ${APP_NAME}.exe  图标/版本已写入`);
} catch (e) {
  console.log('  写入失败（不影响运行）：' + (e.message || e));
}

/* ---------- 5. 统计 + 压缩 ---------- */

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

step(5, '压缩');
const total = dirSize(OUT);
console.log(`  目录  ${OUT}`);
console.log(`  体积  ${mb(total)}`);

await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(ZIP);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  output.on('close', resolve);
  output.on('warning', (e) => {
    if (e.code !== 'ENOENT') reject(e);
  });
  archive.on('error', reject);
  archive.pipe(output);
  archive.directory(OUT, path.basename(OUT));
  archive.finalize();
});
console.log(`  压缩包 ${ZIP}  ${mb(fs.statSync(ZIP).size)}`);

console.log('');
console.log('完成。双击 ' + path.join(OUT, `${APP_NAME}.exe`) + ' 即可运行。');
