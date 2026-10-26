#!/usr/bin/env node
/**
 * 一键发版：打包 → 建 Gitee Release → 上传 zip
 *
 * 用法：
 *   set GITEE_TOKEN=你的私人令牌
 *   node scripts/release.mjs --note "本次更新了 xxx"
 *
 * 令牌在 Gitee → 设置 → 私人令牌 生成，勾 projects 权限即可。
 * 没有令牌也能跑，脚本会打完包后打印手动上传的步骤。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const OWNER = 'work_ai_tools';
const REPO = 'zenway-dashboard-tool';
const API = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}`;
const TOKEN = process.env.GITEE_TOKEN || '';

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
  console.log('没有设置 GITEE_TOKEN，已跳过自动发布。手动上传步骤：');
  console.log(`  1. 打开 https://gitee.com/${OWNER}/${REPO}/releases/new`);
  console.log(`  2. 标签填 ${TAG}，标题填 ${TAG}`);
  console.log(`  3. 上传 ${ZIP}（${sizeMb} MB）`);
  console.log('  4. 发布后客户端下次启动就能收到更新');
  console.log('');
  console.log('想全自动：set GITEE_TOKEN=xxx 后重跑本脚本。');
  process.exit(0);
}

/* ---------- 3. 建 Release ---------- */

async function api(url, init = {}) {
  const res = await fetch(url, init);
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
      access_token: TOKEN,
      tag_name: TAG,
      name: TAG,
      target_commitish: 'main',
      body: note || `禅道挂件 ${TAG}`,
    }),
  });
} catch (e) {
  console.error('创建 Release 失败：' + e.message);
  console.error('常见原因：令牌没勾 projects 权限，或者这个 tag 已经发过了。');
  process.exit(1);
}

const releaseId = release.id;
console.log(`  release id ${releaseId}`);

/* ---------- 4. 上传附件 ---------- */

console.log(`上传 ${path.basename(ZIP)}（${sizeMb} MB）…`);

const fd = new FormData();
fd.append('access_token', TOKEN);
fd.append(
  'file',
  new Blob([fs.readFileSync(ZIP)], { type: 'application/zip' }),
  path.basename(ZIP)
);

try {
  const asset = await api(`${API}/releases/${releaseId}/attach_files`, {
    method: 'POST',
    body: fd,
  });
  console.log(`  附件已上传：${asset.name || path.basename(ZIP)}`);
} catch (e) {
  console.error('附件上传失败：' + e.message);
  console.error('Release 已创建，去网页手动补一个附件也可以。');
  process.exit(1);
}

/* ---------- 5. 收尾 ---------- */

console.log('');
console.log(`发版完成：https://gitee.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
console.log('已经装旧版的同事，下次挂件启动 8 秒后会自动看到更新提示。');
