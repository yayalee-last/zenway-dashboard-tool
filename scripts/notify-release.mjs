#!/usr/bin/env node
/** 补全已公开正式版的说明并通知一次；不创建 Release、改标签或重新上传产物。 */
import fs from 'node:fs';
import { extractReleaseNotes } from './release-notes.mjs';
import { notifyWecomRelease } from './release-notify.mjs';

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) throw new Error('请指定正式版本号，例如 v0.3.13');
const token = process.env.GITHUB_TOKEN;
const webhookUrl = process.env.WECOM_WEBHOOK_URL;
if (!token || !webhookUrl) throw new Error('补发需要 GITHUB_TOKEN 和 WECOM_WEBHOOK_URL');
const notes = extractReleaseNotes(fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), tag.slice(1));
const api = 'https://api.github.com/repos/yayalee-last/zenway-dashboard-tool';

async function request(route, init = {}) {
  const response = await fetch(api + route, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}，未发送企微通知`);
  return response.json();
}

const release = await request(`/releases/tags/${tag}`);
if (release.draft || release.prerelease || !release.published_at) {
  throw new Error('仅可补发已公开的正式版本');
}
const updated = await request(`/releases/${release.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ body: notes }),
});
console.log(`已补全 ${tag} 发布说明：${updated.html_url}`);
await notifyWecomRelease(updated, webhookUrl);
console.log(`已补发一次 ${tag} 企微通知，包含本次更新内容。`);
