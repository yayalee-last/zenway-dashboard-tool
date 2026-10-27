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
import updateFormat from '../electron/update-format.js';
import { notifyWecomRelease } from './release-notify.mjs';
const { APP_ARCHIVE, UPDATE_MANIFEST } = updateFormat;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const OWNER = 'yayalee-last';
const REPO = 'zenway-dashboard-tool';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const TOKEN = process.env.GITHUB_TOKEN || '';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TAG = `v${pkg.version}`;
const ZIP = path.join(ROOT, 'release', 'ZentaoWidget-win32-x64.zip');
const artifacts = [
  { file: ZIP, type: 'application/zip' },
  { file: path.join(ROOT, 'release', APP_ARCHIVE), type: 'application/zip' },
  { file: path.join(ROOT, 'release', UPDATE_MANIFEST), type: 'application/json' },
];

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

for (const artifact of artifacts) {
  if (!fs.existsSync(artifact.file)) {
    console.error(`找不到 ${artifact.file}，先跑一次 npm run pack`);
    process.exit(1);
  }
}
const manifest = JSON.parse(fs.readFileSync(artifacts[2].file, 'utf8'));
if (manifest.version !== pkg.version) throw new Error('更新包版本与 package.json 不一致，请重新打包');

/* ---------- 2. 没有令牌就走手动流程 ---------- */

if (!TOKEN) {
  console.log('');
  console.log('没有设置 GITHUB_TOKEN，已跳过自动发布。手动上传步骤：');
  console.log(`  1. 打开 https://github.com/${OWNER}/${REPO}/releases/new`);
  console.log(`  2. 标签填 ${TAG}，标题填 ${TAG}`);
  console.log(`  3. 上传完整包、应用小包和更新元数据：${artifacts.map((a) => path.basename(a.file)).join('、')}`);
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
      draft: true,
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

const uploadUrl = release.upload_url.replace(/\{.*$/, '');

try {
  for (const artifact of artifacts) {
    const name = path.basename(artifact.file);
    console.log(`上传 ${name} …`);
    const asset = await api(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': artifact.type },
      body: fs.readFileSync(artifact.file),
    });
    console.log(`  附件已上传：${asset.name || name}`);
  }
  try {
    release = await api(`${API}/releases/${releaseId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false }),
    });
  } catch (publishError) {
    // GitHub 可能已执行公开操作，却返回 500 或断开连接；先核对，避免漏通知。
    console.warn('公开 Release 请求异常，正在核对实际状态：' + publishError.message);
    let current;
    try {
      current = await api(`${API}/releases/${releaseId}`);
    } catch (verifyError) {
      throw new Error(`公开请求异常（${publishError.message}），且无法核对 Release 状态：${verifyError.message}`);
    }
    if (current.draft || !current.published_at) throw publishError;
    release = current;
    console.log('已确认 Release 实际公开，继续后续通知。');
  }
} catch (e) {
  console.error('发布失败：' + e.message);
  console.error('未确认发布成功，本次未发送企微通知；请先检查 GitHub Release 状态再重试。');
  process.exit(1);
}


/* ---------- 5. 收尾 ---------- */

console.log('');
console.log(`发版完成：https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
console.log('已经装旧版的同事，下次挂件启动 8 秒后会自动看到更新提示。');
try {
  const sent = await notifyWecomRelease(release, process.env.WECOM_WEBHOOK_URL);
  console.log(sent ? '企微发版通知已发送。' : '未配置企微地址或并非正式版，跳过通知。');
} catch (e) {
  console.error('正式版已发布，但企微通知失败：' + e.message);
  process.exitCode = 1;
}
