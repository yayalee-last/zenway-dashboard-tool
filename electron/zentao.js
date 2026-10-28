'use strict';

/**
 * 禅道 REST API v1 客户端
 *
 * 认证：POST /api.php/v1/tokens { account, password } → token，后续带 Token 头
 * 我的任务：v1 没有「我的地盘」聚合端点，两条策略：
 *   A. GET /tasks?assignedTo=<account>     —— 若服务端支持过滤，一次拿全
 *   B. GET /executions/{id}/tasks?status=assignedtome —— 官方确定支持，需遍历执行
 *
 * 我的缺陷：v1 没有 /my/bugs，也**不支持** assignedTo 过滤（参数被忽略），
 * 只能按产品拉 GET /products/{id}/bugs（默认只含未关闭），再在本地按 assignedTo 筛。
 * 每页固定 20 条，超过要翻页。
 */

const DEFAULTS = {
  baseUrl: '',
  account: '',
  password: '',
  urlMode: 'get', // get: /index.php?m=task&f=view&id=1（任何部署都能用）; path: /task-view-1.html（需伪静态）
  timeoutMs: 15000,
  concurrency: 8,
};

const CLOSED_EXEC = new Set(['closed', 'suspended']);
const { taskChildren, isParentTask } = require('./task-context');
const { positiveId, assertRestOperation, safeExternalUrl } = require('./request-safety');
const { actionPayload } = require('./action-policy');

/** 缺陷列表每页固定 20 条（recPerPage 传多大都没用） */
const BUG_PAGE_SIZE = 20;
const MAX_BUG_PAGES = 4;
const MAX_BUG_PRODUCTS = 20;

/**
 * 清洗用户粘进来的地址，只留部署根路径
 *   http://host:8081/index.php?m=my&f=index  →  http://host:8081
 *   http://host/zentao/index.php             →  http://host/zentao
 *   http://host/zentao/my-work-task.html     →  http://host/zentao
 */
function normalizeBaseUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return s.replace(/\/+$/, '');
  }
  if (!/^https?:$/i.test(u.protocol)) return s.replace(/\/+$/, '');
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length && /\.(php\d?|html?|jsp|aspx?)$/i.test(segs[segs.length - 1])) segs.pop();
  const p = segs.length ? `/${segs.join('/')}` : '';
  return `${u.protocol}//${u.host}${p}`;
}

/** 从原始地址猜链接格式：带 index.php?m= 的是 GET 模式 */
function detectUrlMode(input) {
  const s = String(input || '');
  if (/index\.php\?/i.test(s) || /[?&]m=/i.test(s)) return 'get';
  if (/\/[a-z-]+-\d+(-\d+)*\.html/i.test(s)) return 'path';
  return null;
}

class ZentaoError extends Error {
  constructor(message, status, _body, outcome = 'rejected') {
    super(message);
    this.name = 'ZentaoError';
    this.status = status || 0;
    // Never retain raw server bodies: they can include HTML, credentials or internal URLs.
    this.outcome = outcome;
  }
}

function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  return Promise.all(
    Array.from({ length: n }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    })
  ).then(() => out);
}

/** 禅道的错误体有三种形态：{error:"文本"} / {error:{message:"文本"}} / {message:"文本"} */
function pickError(body, secrets = []) {
  if (!body || typeof body !== 'object') return '';
  const lines = [];
  function visit(value, key = '', depth = 0) {
    if (depth > 3 || lines.length >= 8 || /password|passwd|token|secret|authorization|cookie/i.test(key)) return;
    if (typeof value === 'string') {
      // Do not echo HTML pages, stack traces, headers, URLs or configured secrets.
      let text = value.slice(0, 4000);
      if (/<\/?[a-z!][^>]*>/i.test(text)) return;
      if (/\b(?:password|passwd|pwd|token|secret|authorization|cookie)\s*[=:]/i.test(text)) return;
      for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[已隐藏]');
      text = text.replace(/(?:password|passwd|pwd|token|secret|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, '[敏感信息已隐藏]')
        .replace(/https?:\/\/[^\s<>"']+/gi, '[地址已隐藏]')
        .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
      if (text) lines.push((key ? `${key}: ` : '') + text);
    } else if (Array.isArray(value)) value.slice(0, 4).forEach(entry => visit(entry, key, depth + 1));
    else if (value && typeof value === 'object') {
      Object.entries(value).slice(0, 12).forEach(([field, entry]) => {
        if (/^[a-z][a-z0-9_]{0,40}$/i.test(field)) visit(entry, field === 'message' ? key : field, depth + 1);
      });
    }
  }
  visit(body.error ?? body.message ?? body.msg);
  return lines.join('；').slice(0, 480);
}

function objectId(value, label) {
  try { return positiveId(value, label); } catch (error) { throw new ZentaoError(error.message, 0); }
}

function validatedPayload(kind, action, payload) {
  try { return actionPayload(kind, action, payload); } catch (error) { throw new ZentaoError(error.message, 0); }
}

/** 只认图片魔数：接口一律回 application/octet-stream，靠响应头分不出类型 */
function sniffImageType(b) {
  if (!b || !b.length) return null;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.length > 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class ZentaoClient {
  constructor(cfg = {}) {
    this.applyConfig(cfg);
    this.token = null;
    this.tokenExpireAt = 0;
    this.execCache = null;
    this.projectCache = null;
    this.tasksListBlocked = false;
  }

  applyConfig(cfg = {}) {
    const merged = { ...DEFAULTS, ...cfg };
    const rawBase = String(merged.baseUrl || '').trim();
    merged.baseUrl = normalizeBaseUrl(rawBase);
    const guess = detectUrlMode(rawBase);
    if (guess) merged.urlMode = guess;
    merged.account = String(merged.account || '').trim();
    merged.password = String(merged.password || '');
    merged.concurrency = Math.max(1, Math.min(16, Number(merged.concurrency) || 8));
    merged.timeoutMs = Math.max(3000, Number(merged.timeoutMs) || 15000);
    const changed = merged.baseUrl !== this.cfg?.baseUrl || merged.account !== this.cfg?.account || merged.password !== this.cfg?.password;
    this.cfg = merged;
    if (changed) {
      this.token = null;
      this.tokenExpireAt = 0;
      this.execCache = null;
      this.projectCache = null;
    }
    return this;
  }

  get configured() {
    return Boolean(this.cfg.baseUrl && this.cfg.account && this.cfg.password);
  }

  /* ---------------- http ---------------- */

  async _raw(method, path, { json, token, timeout } = {}) {
    try { assertRestOperation(method, path); } catch (error) { throw new ZentaoError(error.message, 0); }
    const url = this.cfg.baseUrl + path;
    if (!safeExternalUrl(url)) throw new ZentaoError('禅道请求地址无效或包含禁止操作', 0);
    const headers = { Accept: 'application/json' };
    const tk = token === null ? null : token !== undefined ? token : this.token;
    if (tk) headers.Token = tk;
    const init = { method, headers, redirect: 'error', signal: AbortSignal.timeout(timeout || this.cfg.timeoutMs) };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      const hint = String(this.cfg.baseUrl).includes('your-zentao-host') ? '（还是占位地址，先填真实禅道地址）' : '';
      throw new ZentaoError(`连不上禅道${hint}（连接失败、超时或重定向已被阻止）`, 0, null,
        method === 'POST' && !path.endsWith('/tokens') ? 'unknown' : 'rejected');
    }
    if (res.status >= 300 && res.status < 400) throw new ZentaoError('禅道重定向已被阻止，请配置最终部署地址', res.status, null,
      method === 'POST' && !path.endsWith('/tokens') ? 'unknown' : 'rejected');
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    // Token 失效时禅道不会回 401，而是 200 + 一整页登录 HTML，只能靠内容认
    const html = !body && /^\s*<(!doctype|html)/i.test(text);
    return { status: res.status, body, text, html };
  }

  async ensureToken(force = false) {
    if (!this.configured) throw new ZentaoError('还没配置禅道地址 / 账号 / 密码', 0);
    if (!force && this.token && Date.now() < this.tokenExpireAt) return this.token;
    const r = await this._raw('POST', '/api.php/v1/tokens', {
      json: { account: this.cfg.account, password: this.cfg.password },
      token: null,
    });
    const tk = r.body && (r.body.token || (r.body.data && r.body.data.token));
    // 禅道 tokens 是 RESTful 的「创建」语义，返回 201 Created，不是 200
    if ((r.status !== 200 && r.status !== 201) || !tk) {
      const serverMsg = pickError(r.body, [this.cfg.password, this.token]);
      let msg;
      if (r.status === 404) msg = '这个地址上没有 REST API（后台 → 安全 → API 设置 里开启）';
      else if (serverMsg) msg = String(serverMsg);
      else if (r.status === 401 || r.status === 403) msg = '账号或密码不对';
      else if (r.status === 200 && !r.body) msg = '返回的不是 JSON，地址可能不对（只填到部署目录，别带 index.php）';
      else msg = `登录失败（HTTP ${r.status}）`;
      throw new ZentaoError(msg, r.status, r.body);
    }
    this.token = tk;
    this.tokenExpireAt = Date.now() + 25 * 60 * 1000;
    return tk;
  }

  async getJSON(path) {
    try { assertRestOperation('GET', '/api.php/v1' + path); } catch (error) { throw new ZentaoError(error.message, 0); }
    await this.ensureToken();
    let r = await this._raw('GET', '/api.php/v1' + path);
    if (r.status === 401 || r.html) {
      await this.ensureToken(true);
      r = await this._raw('GET', '/api.php/v1' + path);
    }
    if (r.html) throw new ZentaoError('禅道返回了登录页（Token 失效），检查账号密码', 401, null);
    if (r.status !== 200 && r.status !== 201) throw new ZentaoError(`读取失败（HTTP ${r.status}）${pickError(r.body, [this.cfg.password, this.token]) ? '：' + pickError(r.body, [this.cfg.password, this.token]) : ''}`, r.status);
    return r.body || {};
  }

  /** 写操作：POST 到禅道动作端点 */
  async postJSON(path, body = {}) {
    try { assertRestOperation('POST', '/api.php/v1' + path); } catch (error) { throw new ZentaoError(error.message, 0); }
    await this.ensureToken();
    // A lost response/login page does not prove that a write did not execute.
    // Never transparently replay an action after reauthentication.
    const r = await this._raw('POST', '/api.php/v1' + path, { json: body });
    if (r.html) throw new ZentaoError('禅道返回了登录页；操作结果未确认，请先在网页核对，勿直接重试', 401, null, 'unknown');
    if (r.status !== 200 && r.status !== 201) {
      const detail = pickError(r.body, [this.cfg.password, this.token]);
      throw new ZentaoError(`HTTP ${r.status}${detail ? '：' + detail : ''}`, r.status, null, 'unknown');
    }
    return r.body;
  }

  /**
   * 描述里的图片：网页路由 /index.php?m=file&f=read&fileID=95 要会话 cookie，挂件拿不到。
   * 但 GET /api.php/v1/files/95 带 Token 能直接吐二进制，转成 data URL 就能渲染。
   */
  async fetchFileDataUrl(fileId) {
    fileId = objectId(fileId, '图片');
    await this.ensureToken();
    const url = `${this.cfg.baseUrl}/api.php/v1/files/${fileId}`;
    if (!safeExternalUrl(url)) throw new ZentaoError('图片请求地址无效', 0);
    const grab = () => fetch(url, { headers: { Token: this.token }, redirect: 'error', signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    let r = await grab();
    if (r.status === 401) {
      await this.ensureToken(true);
      r = await grab();
    }
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
    const type = sniffImageType(buf);
    if (!type) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  }

  /** 通用附件通过 Token 下载；禁止重定向，避免鉴权头被转发到其他地址。 */
  async downloadFile(fileId, destination) {
    fileId = objectId(fileId, '附件');
    const url = `${this.cfg.baseUrl}/api.php/v1/files/${fileId}`;
    if (!safeExternalUrl(url)) throw new ZentaoError('附件请求地址无效', 0);
    const authenticate = async force => {
      try {
        await this.ensureToken(force);
      } catch (e) {
        throw new ZentaoError('附件认证失败，请检查网络及账号配置', e.status);
      }
    };
    await authenticate(false);
    const grab = async () => {
      try {
        return await fetch(url, {
          headers: { Token: this.token },
          redirect: 'error',
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
      } catch {
        throw new ZentaoError('附件下载失败：连接失败或超时', 0);
      }
    };
    let response = await grab();
    if (response.status === 401) {
      await response.body?.cancel();
      await authenticate(true);
      response = await grab();
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403) throw new ZentaoError('无权限下载此附件', 403);
      if (response.status === 401) throw new ZentaoError('附件登录失效，请检查账号配置', 401);
      throw new ZentaoError(`附件下载失败（HTTP ${response.status}）`, response.status);
    }
    // 文件端点成功响应带 attachment；登录页和 JSON 错误不能交给系统打开。
    if (!/^attachment(?:;|$)/i.test(response.headers.get('content-disposition') || '')) {
      await response.body?.cancel();
      throw new ZentaoError('附件接口未返回文件，请检查登录状态及下载权限', 0);
    }
    const { Readable } = require('node:stream');
    const { pipeline } = require('node:stream/promises');
    const { createWriteStream } = require('node:fs');
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
    } catch {
      throw new ZentaoError('附件下载或保存失败，请检查网络、磁盘空间及目录权限', 0);
    }
  }

  /* ---------------- 数据 ---------------- */

  _accountOf(t) {
    const a = t && t.assignedTo;
    if (!a) return '';
    return typeof a === 'string' ? a : a.account || '';
  }

  taskUrl(id) {
    id = objectId(id, '任务');
    if (this.cfg.urlMode === 'get') return `${this.cfg.baseUrl}/index.php?m=task&f=view&id=${id}`;
    return `${this.cfg.baseUrl}/task-view-${id}.html`;
  }

  bugUrl(id) {
    id = objectId(id, '缺陷');
    if (this.cfg.urlMode === 'get') return `${this.cfg.baseUrl}/index.php?m=bug&f=view&id=${id}`;
    return `${this.cfg.baseUrl}/bug-view-${id}.html`;
  }

  indexUrl() {
    return this.cfg.urlMode === 'get' ? `${this.cfg.baseUrl}/index.php?m=my&f=work&mode=task` : `${this.cfg.baseUrl}/my-work-task.html`;
  }

  async listProjects(force = false) {
    if (!force && this.projectCache && Date.now() - this.projectCache.at < 10 * 60 * 1000) return this.projectCache.list;
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.getJSON(`/projects?recPerPage=200&page=${page}`);
      const list = r.projects || r.data || [];
      all.push(...list);
      if (list.length < 200) break;
    }
    this.projectCache = { at: Date.now(), list: all };
    return all;
  }

  async listExecutions(force = false) {
    if (!force && this.execCache && Date.now() - this.execCache.at < 10 * 60 * 1000) return this.execCache.list;
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.getJSON(`/executions?recPerPage=200&page=${page}`);
      const list = r.executions || r.data || [];
      all.push(...list);
      if (list.length < 200) break;
    }
    this.execCache = { at: Date.now(), list: all };
    return all;
  }

  /** 产品列表：缺陷是按产品维度取的，必须先有这个 */
  async listProducts(force = false) {
    if (!force && this.productCache && Date.now() - this.productCache.at < 10 * 60 * 1000) return this.productCache.list;
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.getJSON(`/products?recPerPage=200&page=${page}`);
      const list = r.products || r.data || [];
      all.push(...list);
      if (list.length < 200) break;
    }
    this.productCache = { at: Date.now(), list: all };
    return all;
  }

  _normalize(t, execName, projectName) {
    const rawName = String(t.name || t.title || '(无标题)');
    // 禅道的子任务名是「父任务 / 子任务」，主标题只留子任务，全名放 tooltip
    let name = rawName;
    let parentName = null;
    const idx = rawName.lastIndexOf(' / ');
    if (idx > 0) {
      parentName = rawName.slice(0, idx);
      name = rawName.slice(idx + 3);
    }
    const dl = t.deadline && !String(t.deadline).startsWith('0000') ? String(t.deadline).slice(0, 10) : null;
    return {
      kind: 'task',
      id: Number(t.id),
      name,
      parentName,
      fullName: rawName,
      status: t.status || 'wait',
      pri: Number(t.pri) || 0,
      deadline: dl,
      left: Number(t.left) || 0,
      consumed: Number(t.consumed) || 0,
      estimate: Number(t.estimate) || 0,
      execution: execName || null,
      project: projectName || null,
      parent: Number(t.parent) || 0,
      isParent: isParentTask(t) ? 1 : 0,
      childrenState: taskChildren(t).state,
      url: this.taskUrl(t.id),
    };
  }

  /**
   * 拿「指派给我」的未完成任务
   * @returns {{items: Array, strategy: string, execCount?: number}}
   */
  async fetchMyTasks() {
    const acct = this.cfg.account;
    const seen = new Set();
    const items = [];
    const push = (t, execName, projectName) => {
      if (!t || seen.has(t.id)) return;
      seen.add(t.id);
      items.push(this._normalize(t, execName, projectName));
    };

    // 策略 A：任务列表带 assignedTo 过滤（多数部署 /tasks 会 403，命中一次就记住别再试）
    let strategy = 'tasks?assignedTo';
    let usedA = false;
    if (!this.tasksListBlocked) {
      try {
        const r = await this.getJSON(`/tasks?recPerPage=100&assignedTo=${encodeURIComponent(acct)}`);
        const list = r.tasks || r.data || [];
        const mine = list.filter((t) => this._accountOf(t) === acct);
        const total = Number(r.total != null ? r.total : list.length);
        if (mine.length > 0 && mine.length === list.length && total <= list.length) {
          mine.forEach((t) => push(t));
          usedA = true;
        }
      } catch (e) {
        if (e && (e.status === 403 || e.status === 404)) this.tasksListBlocked = true;
      }
    }
    if (usedA) return { items, strategy };

    // 策略 B：遍历执行
    strategy = 'executions/*/tasks?status=assignedtome';
    const [execs, projects] = await Promise.all([
      this.listExecutions(),
      this.listProjects().catch(() => []),
    ]);
    const pmap = new Map(projects.map((p) => [Number(p.id), p.name]));
    const active = execs.filter((e) => !CLOSED_EXEC.has(String(e.status)));
    const chunks = await mapLimit(active, this.cfg.concurrency, async (e) => {
      try {
        const r = await this.getJSON(`/executions/${e.id}/tasks?status=assignedtome&recPerPage=200`);
        const list = r.tasks || [];
        return list.map((t) => [t, e.name, pmap.get(Number(e.project))]);
      } catch {
        return [];
      }
    });
    chunks.flat().forEach(([t, en, pn]) => push(t, en, pn));
    return { items, strategy, execCount: active.length };
  }

  /** 任务详情：含 children 子任务、operateMenu 当前可用操作 */
  async getTaskDetail(id) {
    id = objectId(id, '任务');
    return this.getJSON(`/tasks/${id}`);
  }

  /* ---------------- 缺陷 ---------------- */

  _normalizeBug(b, productName) {
    const raw = String(b.title || '(无标题)');
    const dl = b.deadline && !String(b.deadline).startsWith('0000') ? String(b.deadline).slice(0, 10) : null;
    return {
      kind: 'bug',
      id: Number(b.id),
      name: raw,
      fullName: raw,
      parentName: null,
      status: b.status || 'active',
      statusName: b.statusName || '',
      severity: Number(b.severity) || 0,
      pri: Number(b.pri) || 0,
      deadline: dl,
      left: 0,
      consumed: 0,
      estimate: 0,
      product: productName || b.productName || null,
      execution: null,
      project: null,
      parent: 0,
      isParent: 0,
      confirmed: Number(b.confirmed) || 0,
      url: this.bugUrl(b.id),
    };
  }

  /**
   * 拿「指派给我」的未关闭缺陷
   * v1 不支持 assignedTo 过滤，只能按产品翻页拉回来本地筛（未关闭的通常不多）
   */
  async fetchMyBugs() {
    const acct = String(this.cfg.account || '').toLowerCase();
    const products = await this.listProducts();
    const targets = products.filter((p) => !p.deleted).slice(0, MAX_BUG_PRODUCTS);
    let truncated = false;

    const chunks = await mapLimit(targets, this.cfg.concurrency, async (p) => {
      const out = [];
      try {
        for (let page = 1; page <= MAX_BUG_PAGES; page++) {
          const r = await this.getJSON(`/products/${p.id}/bugs?page=${page}`);
          const list = r.bugs || [];
          for (const b of list) {
            if (b.deleted) continue;
            if (this._accountOf(b).toLowerCase() !== acct) continue;
            out.push(this._normalizeBug(b, p.name || b.productName));
          }
          const total = Number(r.total) || 0;
          if (list.length < BUG_PAGE_SIZE) break;
          if (total && page * BUG_PAGE_SIZE >= total) break;
          if (page === MAX_BUG_PAGES) truncated = true;
        }
      } catch (e) {
        // 单个产品读不到不影响别的产品；全挂的时候在下面统一抛
        out.failed = e;
      }
      return out;
    });

    const failed = chunks.filter((c) => c.failed);
    if (targets.length && failed.length === targets.length) throw failed[0].failed;

    const seen = new Set();
    const items = [];
    for (const arr of chunks) {
      for (const b of arr) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        items.push(b);
      }
    }
    return { items, products: targets.length, truncated };
  }

  async getBugDetail(id) {
    id = objectId(id, '缺陷');
    return this.getJSON(`/bugs/${id}`);
  }

  /** 解决缺陷。resolution 必填，resolvedBuild 传版本 ID 或 trunk */
  async resolveBug(id, payload = {}) {
    id = objectId(id, '缺陷');
    const { resolution, resolvedBuild, comment, assignedTo, duplicateBug } = validatedPayload('bug', 'resolve', payload);
    const body = { resolution: resolution || 'fixed', resolvedBuild: resolvedBuild || 'trunk' };
    if (comment) body.comment = comment;
    if (assignedTo) body.assignedTo = assignedTo;
    if (Number(duplicateBug) > 0) body.duplicateBug = Number(duplicateBug);
    return this.postJSON(`/bugs/${id}/resolve`, body);
  }

  /** 关闭缺陷 */
  async closeBug(id, comment = '') {
    id = objectId(id, '缺陷');
    const body = validatedPayload('bug', 'close', { comment });
    return this.postJSON(`/bugs/${id}/close`, body);
  }

  /** 开始任务。禅道要求「总计消耗」和「预计剩余」不能同时为 0 */
  async startTask(id, payload = {}, current) {
    id = objectId(id, '任务');
    const { consumed, left, realStarted, comment } = validatedPayload('task', 'start', payload);
    const task = current || await this.getTaskDetail(id);
    if (!task || Number(task.id) !== id) throw new ZentaoError('任务详情不可用', 0);
    const previousConsumed = Number(task.consumed ?? 0);
    if (!Number.isFinite(previousConsumed) || previousConsumed < 0 || consumed < previousConsumed) throw new ZentaoError('总计消耗不能少于服务器当前消耗，请刷新后填写', 0);
    const body = { assignedTo: this._accountOf(task), consumed, left, realStarted: realStarted || nowStr() };
    if (comment) body.comment = comment;
    return this.postJSON(`/tasks/${id}/start`, body);
  }

  /** 完成任务。realStarted 必填，finishedDate 不能早于它 */
  async finishTask(id, payload = {}, current) {
    id = objectId(id, '任务');
    const { realStarted, finishedDate, currentConsumed, comment } = validatedPayload('task', 'finish', payload);
    const task = current || await this.getTaskDetail(id);
    if (!task || Number(task.id) !== id) throw new ZentaoError('任务详情不可用', 0);
    const rs = realStarted || (task.realStarted && !String(task.realStarted).startsWith('0000') ? task.realStarted : nowStr());
    const fd = finishedDate || nowStr();
    if (new Date(fd) < new Date(rs)) throw new ZentaoError('完成时间不能早于开始时间', 0);
    const body = {
      realStarted: rs,
      finishedDate: fd,
      currentConsumed,
    };
    if (comment) body.comment = comment;
    return this.postJSON(`/tasks/${id}/finish`, body);
  }

  /** 关闭任务 */
  async closeTask(id, comment = '') {
    id = objectId(id, '任务');
    return this.postJSON(`/tasks/${id}/close`, validatedPayload('task', 'close', { comment }));
  }

  /** 连通性 + 权限自检，给设置面板用 */
  async selfTest() {
    const started = Date.now();
    await this.ensureToken(true);
    // 注意：/tasks 全局列表会 403（Access not allowed），用 /executions 自检
    const r = await this.getJSON('/executions?recPerPage=5');
    return {
      ok: true,
      ms: Date.now() - started,
      baseUrl: this.cfg.baseUrl,
      urlMode: this.cfg.urlMode,
      executions: (r.executions || []).length,
    };
  }
}

module.exports = { ZentaoClient, ZentaoError, mapLimit, normalizeBaseUrl, detectUrlMode };
