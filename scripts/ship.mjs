#!/usr/bin/env node
/**
 * 一条命令把改动送上线：改版本号 → 提交 → 推送 → 打包 → 发 Release
 *
 *   npm run ship -- --note "缺陷支持"            # 版本 patch +1，然后全套走完
 *   npm run ship -- --bump minor --note "xxx"   # 手动指定升级幅度
 *   npm run ship -- --same --note "重新发包"     # 版本号不动，只重打包发布
 *   npm run ship -- --ci --note "xxx"           # 只改版本+提交+推送，打包发版交给 GitHub Actions
 *
 * 本地自动发布需要 GITHUB_TOKEN（仓库 Contents 写权限）；CI 使用内置令牌。
 * 没有令牌也能跑：会照常提交推送打包，最后打印手动上传 Release 的步骤。
 *
 * 为什么不能只 git push：客户端的自动更新读的是 **GitHub Release 的 tag 和 zip 附件**，
 * 不是 git 提交。push 只是把源码放上去，不发 Release 客户端永远看不到新版本。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PKG_FILE = path.join(ROOT, 'package.json');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || '' : '';
};

const note = argOf('--note') || argOf('-m');
const bump = argOf('--bump'); // patch | minor | major
const sameVer = argv.includes('--same');
const noPush = argv.includes('--no-push');
const ciMode = argv.includes('--ci'); // 打包发版交给 GitHub Actions，本地只推代码
const dry = argv.includes('--dry'); // 只打印要做什么，不动文件

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

function log(msg) {
  console.log(msg);
}

/* ---------- 1. 版本号 ---------- */

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
let version = pkg.version;
const oldVersion = version;

if (dry) {
  const parts = String(version).split('.').map((n) => Number(n) || 0);
  while (parts.length < 3) parts.push(0);
  const next =
    sameVer || bump === 'none'
      ? version
      : bump === 'major'
        ? `${parts[0] + 1}.0.0`
        : bump === 'minor'
          ? `${parts[0]}.${parts[1] + 1}.0`
          : `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  log(`[dry] 版本      ${version} → ${next}`);
  log(`[dry] 提交信息  release: v${next}${note ? ' — ' + note : ''}`);
  log(`[dry] 推送      ${noPush ? '跳过' : 'git push origin HEAD'}`);
  if (ciMode) {
    log(`[dry] 打包      跳过（--ci，交给 GitHub Actions）`);
    log(`[dry] 发布      跳过（推送后流水线自动打包并建 Release）`);
  } else {
    log(`[dry] 打包      会跑 scripts/pack.mjs`);
    log(`[dry] 发布      ${process.env.GITHUB_TOKEN ? '建 Release 并上传 zip' : '没有 GITHUB_TOKEN，只打印手动步骤'}`);
  }
  process.exit(0);
}

if (!sameVer) {
  const kind = bump || 'patch';
  const parts = String(version)
    .split('.')
    .map((n) => Number(n) || 0);
  while (parts.length < 3) parts.push(0);
  if (kind === 'major') {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (kind === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else if (kind === 'patch') {
    parts[2] += 1;
  } else {
    console.error(`--bump 只能是 patch / minor / major，收到：${kind}`);
    process.exit(1);
  }
  version = parts.join('.');
  pkg.version = version;
  fs.writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + '\n');
  log(`版本号 ${oldVersion} → ${version}`);
} else {
  log(`版本号保持 ${version}`);
}

/* ---------- 2. 提交 ---------- */

const dirty = sh('git', ['status', '--porcelain']);
if (dirty) {
  const msg = `release: v${version}${note ? ' — ' + note : ''}`;
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-m', msg]);
  log(`已提交：${msg}`);
} else {
  log('工作区干净，跳过提交');
}

/* ---------- 3. 推送 ---------- */

if (noPush) {
  log('（--no-push）跳过推送');
} else {
  try {
    // stdio 直连终端，推送进度直接看得见（所以这里不能用会 trim 的 sh）
    execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: ROOT, stdio: 'inherit' });
    log('已推送到 GitHub');
  } catch {
    console.error('推送失败，检查网络或凭据；打包会继续，但客户端拿不到代码。');
  }
}

/* ---------- 4. 打包 + 发 Release ---------- */

if (ciMode) {
  log('');
  log('（--ci）本地不打包不发版，交给 GitHub Actions。');
  log(`去看构建进度：https://github.com/yayalee-last/zenway-dashboard-tool/actions`);
  log(`构建完成后 Release 在：https://github.com/yayalee-last/zenway-dashboard-tool/releases`);
  process.exit(0);
}

log('');
log('开始打包并发布 Release …');
try {
  execFileSync(process.execPath, [path.join(HERE, 'release.mjs'), '--note', note || `禅道挂件 v${version}`], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
} catch {
  console.error('发布环节出错，看看上面的输出。');
  process.exit(1);
}

log('');
log(`搞定。装了旧版的机器：启动 8 秒内、或之后每 4 小时会自动弹更新条。`);
