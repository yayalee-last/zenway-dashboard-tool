#!/usr/bin/env node
/**
 * 一键发版：打包 → 建 GitHub Release → 上传 zip
 *
 * 用法：
 *   set GITHUB_TOKEN=你的仓库令牌
 *   node scripts/release.mjs --note "本次更新了 xxx"
 *
 * 令牌需要此仓库的 Contents 写权限；GitHub Actions 使用内置 GITHUB_TOKEN。
 * 没有令牌也能跑，脚本会打完包后打印手动上传的步骤。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const OWNER = 'yayalee-last';
const REPO = 'zenway-dashboard-tool';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const TOKEN = process.env.GITHUB_TOKEN || '';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TAG = `v${pkg.version}`;
const ZIP = path.join(ROOT, 'release', 'ZentaoWidget-win32-x64.zip');

/* ---------- 参数 ---------- */

const argv = process.argv.slice(2);
const noteIdx = argv.indexOf('--note');
const note = noteIdx >= 0 ? argv[noteIdx + 1] || '' : '';
const skipPack = argv.includes('--skip-pack');

/* ---------- 1. 打包 ---------- */

if (!skipPack) {
  console.log(`打包 ${TAG} …`);
  execFileSync(process.execPath, [path.join(HERE, 'pack.mjs')], { stdio: 'inherit', cwd: ROOT });
}

if (!fs.existsSync(ZIP)) {
  console.error(`找不到 ${ZIP}，先跑一次 npm run pack`);
  process.exit(1);
}
const sizeMb = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(1);

/* ---------- 2. 没有令牌就走手动流程 ---------- */

if (!TOKEN) {
  console.log('');
  console.log('没有设置 GITHUB_TOKEN，已跳过自动发布。手动上传步骤：');
  console.log(`  1. 打开 https://github.com/${OWNER}/${REPO}/releases/new`);
  console.log(`  2. 标签填 ${TAG}，标题填 ${TAG}`);
  console.log(`  3. 上传 ${ZIP}（${sizeMb} MB）`);
  console.log('  4. 发布后客户端下次启动就能收到更新');
  console.log('');
  console.log('想全自动：set GITHUB_TOKEN=xxx 后重跑本脚本，或使用 GitHub Actions。');
  process.exit(0);
}

/* ---------- 3. 建 Release ---------- */

async function api(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': '2026-03-10',
      ...init.headers,
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || text.slice(0, 200);
    throw new Error(`HTTP ${res.status} ${msg}`);
  }
  return body;
}

console.log(`创建 Release ${TAG} …`);

let release;
try {
  release = await api(`${API}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      name: TAG,
      target_commitish: process.env.GITHUB_SHA || 'main',
      body: note || `禅道挂件 ${TAG}`,
    }),
  });
} catch (e) {
  console.error('创建 Release 失败：' + e.message);
  console.error('常见原因：令牌缺少仓库 Contents 写权限，或者这个 tag 已经发过了。');
  process.exit(1);
}

const releaseId = release.id;
console.log(`  release id ${releaseId}`);

/* ---------- 4. 上传附件 ---------- */

console.log(`上传 ${path.basename(ZIP)}（${sizeMb} MB）…`);

const uploadUrl = release.upload_url.replace(/\{.*$/, '');

try {
  const asset = await api(`${uploadUrl}?name=${encodeURIComponent(path.basename(ZIP))}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: fs.readFileSync(ZIP),
  });
  console.log(`  附件已上传：${asset.name || path.basename(ZIP)}`);
} catch (e) {
  console.error('附件上传失败：' + e.message);
  console.error('Release 已创建，去网页手动补一个附件也可以。');
  process.exit(1);
}

/* ---------- 5. 收尾 ---------- */

console.log('');
console.log(`发版完成：https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
console.log('已经装旧版的同事，下次挂件启动 8 秒后会自动看到更新提示。');
