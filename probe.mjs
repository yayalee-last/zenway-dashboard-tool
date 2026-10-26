#!/usr/bin/env node
/**
 * 禅道接口探测
 * 目的：确认你这套禅道能用哪种方式对接、以及"我的任务/待办"从哪个接口取。
 *
 * 用法：
 *   1. 编辑同目录 zentao.config.json（baseUrl / account / password）
 *   2. node probe.mjs
 *   3. 看终端输出，结果同时写到 probe-result.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(HERE, 'zentao.config.json');
const EXAMPLE_PATH = path.join(HERE, 'zentao.config.example.json');

// zentao.config.json 里有账号密码，不进版本库；首次用就从模板复制一份
if (!fs.existsSync(CFG_PATH)) {
  if (fs.existsSync(EXAMPLE_PATH)) {
    fs.copyFileSync(EXAMPLE_PATH, CFG_PATH);
    console.log(`已从模板生成 zentao.config.json，填好 baseUrl / account / password 后再跑一次`);
    process.exit(1);
  }
  console.error(`找不到 ${CFG_PATH}，请先创建并填写 baseUrl / account / password`);
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
if (!cfg.baseUrl || !cfg.account || !cfg.password) {
  console.error('zentao.config.json 里 baseUrl / account / password 必须都填');
  process.exit(1);
}

const BASE = String(cfg.baseUrl).replace(/\/+$/, '');
const TIMEOUT = Number(cfg.timeoutMs) || 15000;
const MAX_EXEC = Number(cfg.maxExecutions) || 120;
const PREFIX = '/api.php/v1';

const isTTY = process.stdout.isTTY;
const paint = (code, s) => (isTTY ? `\u001b[${code}m${s}\u001b[0m` : s);
const ok = (m) => console.log(`${paint(32, '[OK]')} ${m}`);
const no = (m) => console.log(`${paint(31, '[--]')} ${m}`);
const warn = (m) => console.log(`${paint(33, '[!!]')} ${m}`);
const head = (m) => console.log(`\n${paint(1, m)}`);

/* ---------------- http ---------------- */

async function req(method, p, { token, json } = {}) {
  const url = p.startsWith('http') ? p : BASE + p;
  const headers = { Accept: 'application/json' };
  if (token) headers.Token = token;
  const init = { method, headers, signal: AbortSignal.timeout(TIMEOUT) };
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, text };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

/* ---------------- 1. 认证 ---------------- */

head('1. REST API v1 认证');
console.log(`   禅道地址：${BASE}`);
console.log(`   账号：${cfg.account}`);

const auth = await req('POST', `${PREFIX}/tokens`, {
  json: { account: cfg.account, password: cfg.password },
});

const report = { baseUrl: BASE, account: cfg.account, auth: null, endpoints: [], tasks: [], stats: {} };

const token = auth.body?.token;
if (auth.status === 200 && token) {
  ok(`token 已获取（长度 ${String(token).length}）`);
  report.auth = { mode: 'rest-v1-token', ok: true };
} else {
  no(`认证失败：HTTP ${auth.status || auth.error}`);
  if (auth.status === 404) {
    warn('404 → 这套禅道没有开放 /api.php/v1，多半是 18.x 之前的版本');
    warn('办法：让运维升级到 18.x+，或走"页面 JSON 接口 + cookie 登录"这条路（要处理 verifyRand）');
  } else if (auth.status === 401 || auth.status === 403) {
    warn('401/403 → 账号密码不对，或该账号没开放 API 权限');
  } else if (auth.status === 0) {
    warn(`连不上：${auth.error}。确认在内网 / VPN，或 baseUrl 写错（有些部署带 /zentao 子路径）`);
  }
  fs.writeFileSync(path.join(HERE, 'probe-result.json'), JSON.stringify(report, null, 2));
  process.exit(2);
}

/* ---------------- 2. 端点可用性 ---------------- */

head('2. 端点探测');

const ENDPOINTS = [
  ['/my/profile', '我的资料'],
  ['/my/todos', '我的待办（推测路径）'],
  ['/my/tasks', '我的任务（推测路径）'],
  ['/tasks?recPerPage=5', '任务列表'],
  ['/bugs?recPerPage=5', 'Bug 列表'],
  ['/stories?recPerPage=5', '需求列表'],
  ['/projects?recPerPage=5', '项目列表'],
  ['/executions?recPerPage=5', '执行列表'],
];

for (const [p, label] of ENDPOINTS) {
  const r = await req('GET', PREFIX + p, { token });
  const good = r.status === 200;
  report.endpoints.push({ path: p, label, status: r.status, ok: good });
  if (good) {
    const n =
      r.body?.total ??
      (Array.isArray(r.body?.data) ? r.body.data.length : undefined) ??
      Object.keys(r.body || {}).filter((k) => Array.isArray(r.body[k])).map((k) => `${k}:${r.body[k].length}`).join(',');
    ok(`${label.padEnd(18, ' ')} ${p}  → 200  ${n !== undefined ? `(${n})` : ''}`);
  } else {
    no(`${label.padEnd(18, ' ')} ${p}  → ${r.status || r.error}`);
  }
}

/* ---------------- 3. 我的任务 ---------------- */

head('3. 收集"我的任务"');

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const acct = cfg.account;
let myTasks = [];
let strategy = null;

// 策略 A：任务列表直接按 assignedTo 过滤
const byAssignee = await req('GET', `${PREFIX}/tasks?recPerPage=100&assignedTo=${encodeURIComponent(acct)}`, { token });
const sample = byAssignee.body?.tasks || byAssignee.body?.data;
const filterWorks =
  byAssignee.status === 200 &&
  Array.isArray(sample) &&
  sample.length > 0 &&
  sample.every((t) => (t.assignedTo?.account || t.assignedTo) === acct);

if (filterWorks) {
  strategy = 'tasks?assignedTo=account';
  ok(`任务列表支持 assignedTo 过滤 → 一次拿全（${byAssignee.body.total ?? sample.length} 条）`);
  myTasks = sample;
} else {
  warn('任务列表不支持（或未生效）assignedTo 过滤 → 回退：遍历执行');
  const exRes = await req('GET', `${PREFIX}/executions?recPerPage=100`, { token });
  const execs = (exRes.body?.executions || []).slice(0, MAX_EXEC);
  if (!execs.length) {
    no('拿不到执行列表，没法聚合');
  } else {
    ok(`共 ${execs.length} 个执行，逐个查 assignedtome …`);
    const chunks = await mapLimit(execs, 5, async (e) => {
      const r = await req('GET', `${PREFIX}/executions/${e.id}/tasks?status=assignedtome&recPerPage=200`, { token });
      const list = r.status === 200 ? r.body?.tasks || [] : [];
      return list.map((t) => ({ ...t, _executionName: e.name }));
    });
    myTasks = chunks.flat();
    strategy = 'executions/:id/tasks?status=assignedtome';
    ok(`聚合到 ${myTasks.length} 条我的任务`);
  }
}

/* ---------------- 4. 汇总 ---------------- */

const OPEN = new Set(['wait', 'doing', 'pause']);
const open = myTasks.filter((t) => OPEN.has(t.status));
const stats = {};
for (const t of myTasks) stats[t.status] = (stats[t.status] || 0) + 1;

head('4. 结果');
console.log(`   取数策略：${strategy}`);
console.log(`   我的任务：${myTasks.length} 条（未完成 ${open.length} 条）`);
console.log(`   状态分布：${JSON.stringify(stats)}`);

open
  .sort((a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')))
  .slice(0, 20)
  .forEach((t) => {
    console.log(
      `   #${String(t.id).padEnd(6)} [${t.status}] pri${t.pri}  剩${t.left}h  ` +
        `截止 ${String(t.deadline || '-').slice(0, 10)}  ${t.name}`
    );
  });

report.tasks = myTasks;
report.stats = { total: myTasks.length, open: open.length, byStatus: stats };
report.strategy = strategy;
fs.writeFileSync(path.join(HERE, 'probe-result.json'), JSON.stringify(report, null, 2));
console.log(`\n   完整数据已写入 probe-result.json`);

/* ---------------- 5. 待办 / 需求 ---------------- */

head('5. 待办与需求');
const hasTodos = report.endpoints.find((e) => e.path === '/my/todos')?.ok;
if (hasTodos) ok('存在 /my/todos 端点，可直接取待办');
else warn('/my/todos 不可用 → 待办要走页面 JSON 接口 /my-work-task.json（需要 cookie 登录态），或放弃待办只做任务+Bug');
