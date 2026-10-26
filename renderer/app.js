'use strict';

const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  wait: '未开始',
  doing: '进行中',
  pause: '已暂停',
  done: '已完成',
  closed: '已关闭',
  cancel: '已取消',
};

/** 缺陷状态跟任务不是一套词 */
const BUG_STATUS = { active: '激活', resolved: '已解决', closed: '已关闭' };
const SEV_LABEL = { 1: '致命', 2: '严重', 3: '一般', 4: '建议' };
const BUG_TYPE = {
  codeerror: '代码错误',
  config: '配置相关',
  install: '安装部署',
  security: '安全相关',
  performance: '性能问题',
  standard: '标准规范',
  automation: '测试脚本',
  designdefect: '设计缺陷',
  others: '其他',
};
const RESOLUTION_LABEL = {
  fixed: '已解决',
  bydesign: '设计如此',
  duplicate: '重复 Bug',
  external: '外部原因',
  notrepro: '无法重现',
  postponed: '延期处理',
  willnotfix: '不予解决',
  tostory: '转需求',
};

const DONE = new Set(['done', 'closed', 'cancel']);
const RANK = { overdue: 0, today: 1, soon: 2, later: 3 };

const S = {
  items: [],
  cfg: {},
  st: { ok: false, items: [], at: 0, error: null, needSetup: true },
  filter: 'open',
  spinning: false,
  up: {},
  upDismissed: false,
};

/* ---------------- 工具 ---------------- */

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d - today) / 86400000);
}

function urgentOf(item) {
  const n = daysUntil(item.deadline);
  if (n === null) return 'later';
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  if (n <= 3) return 'soon';
  return 'later';
}

function isDone(it) {
  const s = String(it.status || '').toLowerCase();
  // 缺陷的 resolved 还没关闭，仍算在手头（等确认/关闭）
  if (it.kind === 'bug') return s === 'closed' || s === 'cancel';
  return DONE.has(s);
}

function fmtClock(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dueLabel(item) {
  if (!item.deadline) return '';
  const n = daysUntil(item.deadline);
  const md = item.deadline.slice(5);
  if (n === null) return md;
  if (n < 0) return `逾期 ${-n} 天`;
  if (n === 0) return '今天到期';
  if (n === 1) return '明天到期';
  if (n <= 7) return `${n} 天后`;
  return md;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

/* ---------------- 渲染 ---------------- */

function visibleItems() {
  let arr = S.items.slice();
  const f = S.filter;

  if (f === 'open') arr = arr.filter((i) => !isDone(i));
  else if (f === 'bug') arr = arr.filter((i) => i.kind === 'bug' && !isDone(i));
  else if (f === 'overdue') arr = arr.filter((i) => !isDone(i) && daysUntil(i.deadline) !== null && daysUntil(i.deadline) < 0);
  else if (f === 'today') arr = arr.filter((i) => !isDone(i) && daysUntil(i.deadline) === 0);

  arr.sort((a, b) => {
    const ra = RANK[urgentOf(a)];
    const rb = RANK[urgentOf(b)];
    if (ra !== rb) return ra - rb;
    const da = a.deadline || '9999-12-31';
    const db = b.deadline || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    return (a.pri || 9) - (b.pri || 9);
  });
  return arr;
}

function renderList() {
  const list = $('list');
  const items = visibleItems();
  list.replaceChildren();

  if (items.length) {
    const frag = document.createDocumentFragment();
    for (const it of items) frag.append(renderItem(it));
    list.append(frag);
    return;
  }

  if (S.st.needSetup || !S.cfg.baseUrl) {
    list.append(renderEmpty('还没连上禅道', '填一下地址和账号，任务和缺陷就挂桌面上了', '去配置'));
  } else if (S.st.error) {
    list.append(renderEmpty('拉取失败', S.st.error, '检查连接'));
  } else if (S.filter === 'bug') {
    list.append(
      S.st.bugWarn
        ? renderEmpty('缺陷没拉下来', S.st.bugWarn, '检查连接')
        : renderEmpty('没有派给你的缺陷', '测试提给你的 bug 会出现在这儿', null)
    );
  } else if (S.filter === 'all' || S.filter === 'open') {
    list.append(
      S.items.length
        ? renderEmpty('这一栏是空的', '切到别的分栏看看', null)
        : renderEmpty('没有代办', '安心干活', null)
    );
  } else {
    list.append(renderEmpty('这一栏是空的', '切到「未完成」看看', null));
  }
}

function renderEmpty(title, sub, btnText) {
  const box = el('div', 'empty');
  box.append(el('div', 'big', title));
  box.append(el('div', null, sub));
  if (btnText) {
    const b = el('button', 'btn primary', btnText);
    b.style.flex = 'none';
    b.style.padding = '0 18px';
    b.addEventListener('click', openSettings);
    box.append(b);
  }
  return box;
}

function renderItem(it) {
  if (it.kind === 'bug') return renderBugItem(it);

  const urgent = urgentOf(it);
  const statusLower = String(it.status || '').toLowerCase();

  const row = el('div', 'item');
  row.dataset.urgent = urgent;
  row.dataset.status = statusLower;
  row.title = `${it.fullName || it.name}\n#${it.id}${it.execution ? ` · ${it.execution}` : ''}`;

  row.append(el('div', 'bar'));

  const body = el('div', 'body');
  const head = el('div', 'head');

  // 有父任务、或者自己是父任务 → 能展开看这一组的子任务
  if (it.parent > 0 || it.isParent > 0) {
    const exp = el('button', 'expander');
    exp.title = '展开子任务';
    exp.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTree(row, it, exp);
    });
    head.append(exp);
  }

  head.append(el('div', 'name', it.name));
  body.append(head);

  const meta = el('div', 'meta');

  const pri = el('span', 'pri-dot');
  pri.dataset.pri = String(it.pri || 0);
  pri.append(el('i'));
  pri.append(el('span', null, it.pri ? `P${it.pri}` : '-'));
  meta.append(pri);

  meta.append(el('span', `tag ${statusLower}`, STATUS_LABEL[statusLower] || it.status || ''));

  if (it.left > 0) meta.append(el('span', null, `剩 ${it.left}h`));

  if (it.deadline) {
    meta.append(el('span', `due ${urgent}`, dueLabel(it)));
  } else if (it.execution) {
    meta.append(el('span', 'due', String(it.execution).replace(/^【[^】]+】/, '')));
  }

  body.append(meta);
  row.append(body);

  // 快速流转：待开始 → 开始；进行中 → 完成
  const acts = el('div', 'acts');
  if (statusLower === 'wait') acts.append(mkAct('开始', 'start', it));
  else if (statusLower === 'doing') acts.append(mkAct('完成', 'finish', it));
  if (acts.children.length) row.append(acts);

  row.addEventListener('click', () => {
    openDetail(it);
  });

  return row;
}

/** 缺陷条目：比任务多一个严重程度，少工时就、子任务那套 */
function renderBugItem(it) {
  const st = String(it.status || '').toLowerCase();
  const urgent = urgentOf(it);

  const row = el('div', 'item bug');
  row.dataset.urgent = urgent;
  row.dataset.status = st;
  row.dataset.kind = 'bug';
  row.title = `${it.name}\n缺陷 #${it.id}${it.product ? ` · ${it.product}` : ''}`;

  row.append(el('div', 'bar'));

  const body = el('div', 'body');
  const head = el('div', 'head');
  head.append(el('div', 'name', it.name));
  body.append(head);

  const meta = el('div', 'meta');
  meta.append(el('span', 'tag bug', 'BUG'));
  meta.append(el('span', `tag b-${st}`, it.statusName || BUG_STATUS[st] || it.status || ''));
  meta.append(mkSev(it.severity));
  if (it.pri) meta.append(el('span', 'pri-txt', `P${it.pri}`));

  if (it.deadline) meta.append(el('span', `due ${urgent}`, dueLabel(it)));
  else if (it.product) meta.append(el('span', 'due muted', String(it.product).replace(/^【[^】]+】/, '')));

  body.append(meta);
  row.append(body);

  const acts = el('div', 'acts');
  if (st === 'active') acts.append(mkBugAct('解决', 'resolve', it));
  else if (st === 'resolved') acts.append(mkBugAct('关闭', 'close', it));
  if (acts.children.length) row.append(acts);

  row.addEventListener('click', () => openDetail(it));
  return row;
}

function mkSev(n) {
  const s = el('span', 'sev');
  s.dataset.sev = String(Number(n) || 0);
  s.textContent = n ? `S${n}` : 'S-';
  s.title = n ? `严重程度：${SEV_LABEL[n] || n}` : '未设置严重程度';
  return s;
}

function mkBugAct(text, action, it) {
  const b = el('button', `act ${action}`, text);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    openBugAction(action, it);
  });
  return b;
}

function mkAct(text, action, it) {
  const b = el('button', `act ${action}`, text);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    openTaskAction(action, it);
  });
  return b;
}

function taskUrl(id) {
  const base = String(S.cfg.baseUrl || '').replace(/\/+$/, '');
  return S.cfg.urlMode === 'get'
    ? `${base}/index.php?m=task&f=view&id=${id}`
    : `${base}/task-view-${id}.html`;
}

/* ---------------- 展开子任务 ---------------- */

async function toggleTree(row, it, btn) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('subs')) {
    next.remove();
    btn.classList.remove('open');
    requestAnimationFrame(autoHeight);
    return;
  }

  btn.disabled = true;
  const pid = it.isParent > 0 ? it.id : it.parent;
  const r = await window.zt.taskDetail(pid);
  btn.disabled = false;

  if (!r.ok) return toast(r.error || '拉取子任务失败', 'bad');

  // 只留派给自己的，并且把当前这一行本身剔掉（否则会重复显示自己）
  const kids = (r.task.children || []).filter((c) => c.id !== it.id);
  const others = Number(r.task.othersCount) || 0;
  if (!kids.length && !others) return toast('这一组没有子任务');

  const box = el('div', 'subs');

  // 叶子任务：先给一条父任务，方便一眼看出自己这条属于哪个大需求
  if (pid !== it.id && r.task.name) {
    const up = el('div', 'sub up');
    up.textContent = `↳ ${r.task.name}`;
    up.title = `父任务：${r.task.name}`;
    up.addEventListener('click', (e) => {
      e.stopPropagation();
      window.zt.open(taskUrl(pid));
    });
    box.append(up);
  }

  for (const c of kids) {
    const st = String(c.status || '').toLowerCase();
    const line = el('div', 'sub');
    line.title = `${c.name}\n${c.realname || c.account || ''}`;
    line.append(el('span', `sdot ${st}`, ''));
    line.append(el('span', 'sname', c.name));
    line.append(el('span', 'swho', c.left > 0 ? `剩${c.left}h · ${STATUS_LABEL[st] || c.status}` : STATUS_LABEL[st] || c.status));
    line.addEventListener('click', (e) => {
      e.stopPropagation();
      window.zt.open(c.url || taskUrl(c.id));
    });
    box.append(line);
  }

  // 别人的子任务不列出来，但给一句可点的提示，别让人以为漏了
  if (others > 0) {
    const more = el('div', 'sub more');
    more.textContent = kids.length
      ? `另有 ${others} 条派给别人的子任务，去禅道看`
      : `同组还有 ${others} 条派给别人的子任务，去禅道看`;
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      window.zt.open(taskUrl(pid));
    });
    box.append(more);
  }

  row.insertAdjacentElement('afterend', box);
  btn.classList.add('open');
  requestAnimationFrame(autoHeight);
}

/* ---------------- 快速流转 ---------------- */

let pending = null;

function openTaskAction(action, it) {
  pending = { action, it };
  const finishing = action === 'finish';
  $('tm-title').textContent = finishing ? '完成任务' : '开始任务';
  $('tm-task').textContent = it.name;
  $('tm-consumed-label').textContent = finishing ? '本次消耗（小时）' : '预计消耗（小时）';
  $('tm-consumed').value = finishing ? String(it.left || 0) : '0.5';
  $('tm-left').value = finishing ? '0' : String(it.left || 0);
  $('tm-err').hidden = true;
  $('tm-ok').disabled = false;
  $('tm-ok').textContent = '确认';
  $('task-modal').hidden = false;
  $('tm-consumed').focus();
  $('tm-consumed').select();
}

function closeTaskAction() {
  $('task-modal').hidden = true;
  pending = null;
}

async function confirmTaskAction() {
  if (!pending) return;
  const consumed = Number($('tm-consumed').value) || 0;
  const left = Number($('tm-left').value) || 0;
  const btn = $('tm-ok');
  btn.disabled = true;
  btn.textContent = '提交中…';

  const payload = pending.action === 'finish' ? { currentConsumed: consumed, left } : { consumed, left };
  const r = await window.zt.taskAction({ id: pending.it.id, action: pending.action, payload });

  btn.disabled = false;
  btn.textContent = '确认';

  if (!r.ok) {
    $('tm-err').hidden = false;
    $('tm-err').textContent = r.error || '操作失败';
    return;
  }

  const done = pending.action === 'finish';
  closeTaskAction();
  toast(done ? '已完成' : '已开始', 'ok');
  if (DT.open && DT.data && DT.data.id) loadDetail(DT.data.id);
}

/* ---------------- 缺陷流转（解决 / 关闭） ---------------- */

let bugPending = null;

function openBugAction(action, it) {
  bugPending = { action, it };
  const resolving = action === 'resolve';
  $('bm-title').textContent = resolving ? '解决缺陷' : '关闭缺陷';
  $('bm-task').textContent = it.name || it.title || `缺陷 #${it.id}`;
  $('bm-resolve-fields').hidden = !resolving;
  $('bm-resolution').value = 'fixed';
  $('bm-build').value = 'trunk';
  $('bm-comment-label').textContent = resolving ? '备注（可选）' : '关闭原因（可选）';
  $('bm-comment').placeholder = resolving ? '改了什么 / 为什么这么解决' : '为什么可以关闭，比如已验证通过';
  $('bm-comment').value = '';
  $('bm-err').hidden = true;
  $('bm-ok').disabled = false;
  $('bm-ok').textContent = '确认';
  $('bug-modal').hidden = false;
  window.zt.resize(560);
  $('bm-comment').focus();
}

function closeBugAction() {
  $('bug-modal').hidden = true;
  bugPending = null;
  requestAnimationFrame(autoHeight);
}

async function confirmBugAction() {
  if (!bugPending) return;
  const { action, it } = bugPending;
  const comment = $('bm-comment').value.trim();
  const payload =
    action === 'resolve'
      ? { resolution: $('bm-resolution').value, resolvedBuild: $('bm-build').value.trim() || 'trunk', comment }
      : { comment };

  const btn = $('bm-ok');
  btn.disabled = true;
  btn.textContent = '提交中…';
  const r = await window.zt.bugAction({ id: it.id, action, payload });
  btn.disabled = false;
  btn.textContent = '确认';

  if (!r.ok) {
    $('bm-err').hidden = false;
    $('bm-err').textContent = r.error || '操作失败';
    return;
  }

  closeBugAction();
  toast(action === 'resolve' ? '已标记为解决' : '缺陷已关闭', 'ok');
  if (DT.open && DT.kind === 'bug' && DT.id === it.id) loadBugDetail(it.id);
}

/* ---------------- 任务详情（挂件内直接看） ---------------- */

const DT = { open: false, kind: 'task', id: 0, data: null };

function fmtDT(v) {
  if (!v) return '';
  const s = String(v);
  let d = new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}/.test(s) && !s.endsWith('Z') ? s.replace(' ', 'T') : s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function openDetail(it) {
  DT.open = true;
  DT.kind = it.kind === 'bug' ? 'bug' : 'task';
  DT.id = it.id;
  DT.data = null;
  $('dt-id').textContent = `${DT.kind === 'bug' ? '缺陷 ' : ''}#${it.id}`;
  $('dt-body').replaceChildren(el('div', 'dt-empty', '读取中…'));
  $('dt-foot').hidden = true;
  $('list').hidden = true;
  $('tabs').hidden = true;
  $('detail').hidden = false;
  $('dt-body').scrollTop = 0;
  window.zt.resize(600);
  if (DT.kind === 'bug') await loadBugDetail(it.id);
  else await loadDetail(it.id);
}

async function loadBugDetail(id) {
  const r = await window.zt.bugDetail(id);
  if (!DT.open || DT.kind !== 'bug' || DT.id !== id) return;
  if (!r.ok) {
    $('dt-body').replaceChildren(el('div', 'dt-empty', r.error || '读取失败'));
    return;
  }
  DT.data = r.bug;
  renderBugDetail(r.bug);
}

async function loadDetail(id) {
  const r = await window.zt.taskDetail(id);
  if (!DT.open || DT.id !== id) return;
  if (!r.ok) {
    $('dt-body').replaceChildren(el('div', 'dt-empty', r.error || '读取失败'));
    return;
  }
  DT.data = r.task;
  renderDetail(r.task);
}

function closeDetail() {
  DT.open = false;
  DT.kind = 'task';
  DT.data = null;
  $('detail').hidden = true;
  $('list').hidden = false;
  $('tabs').hidden = false;
  renderAll();
}

/** 图片大多已经内联成 data URL；万一还是加载失败，就换成可点的占位条 */
function fixImages(root) {
  const imgs = [...root.querySelectorAll('img')];
  for (const [i, img] of imgs.entries()) {
    const src = img.getAttribute('data-orig') || img.getAttribute('src') || '';
    // 能显示的图：点一下用浏览器看原图（挂件里只有 380px 宽）
    img.style.cursor = 'pointer';
    img.title = '点击在浏览器查看原图';
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      if (src && /^https?:/i.test(src)) window.zt.open(src);
    });

    const mark = () => {
      if (!img.isConnected) return;
      const ph = el('div', 'imgph');
      ph.title = src;
      ph.append(el('span', 'imgph-ico', '图'));
      ph.append(el('span', null, `图片 ${i + 1}`));
      ph.append(el('span', 'imgph-open', '浏览器打开'));
      ph.addEventListener('click', (e) => {
        e.stopPropagation();
        if (src) window.zt.open(src);
      });
      img.replaceWith(ph);
    };
    img.addEventListener('error', mark, { once: true });
    if (img.complete && img.naturalWidth === 0) mark();
  }
}

function renderDetail(t) {
  const body = $('dt-body');
  const st = String(t.status || '').toLowerCase();
  body.replaceChildren();

  body.append(el('div', 'dt-title', t.name));

  const badges = el('div', 'dt-badges');
  badges.append(el('span', `tag ${st}`, STATUS_LABEL[st] || t.status || ''));

  const pri = el('span', 'pri-dot');
  pri.dataset.pri = String(t.pri || 0);
  pri.append(el('i'));
  pri.append(el('span', null, t.pri ? `P${t.pri}` : '-'));
  badges.append(pri);

  if (t.deadline) badges.append(el('span', `due ${urgentOf(t)}`, dueLabel(t)));
  body.append(badges);

  const grid = el('div', 'dt-grid');
  const kv = (k, v, strong) => {
    if (v === undefined || v === null) return;
    const s = String(v).trim();
    if (!s || s === '-' || s === '/') return;
    const c = el('div', 'kv');
    c.append(el('div', 'k', k));
    c.append(el('div', strong ? 'v strong' : 'v', s));
    grid.append(c);
  };
  kv('所属迭代', t.executionName);
  kv('模块', t.moduleTitle);
  kv('指派给', t.assignedRealname);
  kv('工时 预计/已耗/剩', `${t.estimate || 0} / ${t.consumed || 0} / ${t.left || 0} h`, true);
  kv('截止', t.deadline || '未设置');
  kv('创建', `${t.openedBy || ''}${t.openedDate ? ` · ${fmtDT(t.openedDate)}` : ''}`);
  if (t.realStarted) kv('开始', fmtDT(t.realStarted));
  if (t.finishedDate) kv('完成', fmtDT(t.finishedDate));
  if (t.storyTitle) kv('关联需求', t.storyTitle);
  if (grid.children.length) body.append(grid);

  // 父任务
  if (t.parentName) {
    body.append(el('div', 'dt-h', '父任务'));
    const up = el('div', 'dt-sub');
    up.append(el('span', 'sname', t.parentName));
    up.append(el('span', 'swho', '点开'));
    up.addEventListener('click', () => openDetail({ id: t.parent }));
    body.append(up);
  }

  // 描述
  body.append(el('div', 'dt-h', '任务描述'));
  if (t.desc && t.desc.trim()) {
    const d = el('div', 'dt-desc');
    d.innerHTML = t.desc;
    body.append(d);
    fixImages(d);
  } else {
    body.append(el('div', 'dt-empty', '这条任务没写描述'));
  }

  // 子任务
  if (t.children && t.children.length) {
    body.append(el('div', 'dt-h', `子任务 ${t.children.length}`));
    for (const c of t.children) {
      const cst = String(c.status || '').toLowerCase();
      const line = el('div', 'dt-sub');
      line.append(el('span', `sdot ${cst}`, ''));
      line.append(el('span', 'sname', c.name));
      line.append(el('span', 'swho', c.left > 0 ? `剩${c.left}h · ${STATUS_LABEL[cst] || c.status}` : STATUS_LABEL[cst] || c.status));
      line.addEventListener('click', () => openDetail({ id: c.id }));
      body.append(line);
    }
  } else if (t.othersCount > 0) {
    body.append(el('div', 'dt-h', '子任务'));
    body.append(el('div', 'dt-empty', `另有 ${t.othersCount} 条子任务派给别人`));
  }

  // 动态
  if (t.history && t.history.length) {
    body.append(el('div', 'dt-h', '动态'));
    const log = el('div', 'dt-log');
    for (const h of t.history) {
      const lg = el('div', 'lg');
      lg.append(el('b', null, h.actor || '系统'));
      lg.append(document.createTextNode(` ${fmtDT(h.date)}`));
      if (h.text) lg.append(el('div', null, h.text));
      if (h.comment) {
        const c = el('span', 'cmt');
        c.innerHTML = h.comment;
        lg.append(c);
      }
      log.append(lg);
    }
    body.append(log);
  }

  // 底部动作
  const foot = $('dt-foot');
  foot.replaceChildren();
  const act = st === 'wait' ? ['start', '开始任务'] : st === 'doing' ? ['finish', '完成任务'] : null;
  if (act) {
    const b = el('button', 'btn primary', act[1]);
    b.addEventListener('click', () => openTaskAction(act[0], t));
    foot.append(b);
  }
  const open = el('button', 'btn ghost', '浏览器打开');
  open.addEventListener('click', () => window.zt.open(t.url || taskUrl(t.id)));
  foot.append(open);
  foot.hidden = false;
}

/** 缺陷详情：重现步骤是富文本，图片同样内联成 data URL */
function renderBugDetail(b) {
  const body = $('dt-body');
  const st = String(b.status || '').toLowerCase();
  body.replaceChildren();

  body.append(el('div', 'dt-title', b.title));

  const badges = el('div', 'dt-badges');
  badges.append(el('span', `tag b-${st}`, b.statusName || BUG_STATUS[st] || b.status || ''));
  badges.append(mkSev(b.severity));
  const pri = el('span', 'pri-dot');
  pri.dataset.pri = String(b.pri || 0);
  pri.append(el('i'));
  pri.append(el('span', null, b.pri ? `P${b.pri}` : '-'));
  badges.append(pri);
  if (b.deadline) badges.append(el('span', `due ${urgentOf(b)}`, dueLabel(b)));
  if (Number(b.activatedCount) > 0) badges.append(el('span', 'b-act', `激活 ${b.activatedCount} 次`));
  body.append(badges);

  const grid = el('div', 'dt-grid');
  const kv = (k, v, strong) => {
    if (v === undefined || v === null) return;
    const s = String(v).trim();
    if (!s || s === '-' || s === '/') return;
    const c = el('div', 'kv');
    c.append(el('div', 'k', k));
    c.append(el('div', strong ? 'v strong' : 'v', s));
    grid.append(c);
  };
  kv('所属产品', b.productName);
  kv('所属项目', b.projectName);
  kv('模块', b.moduleTitle);
  kv('类型', BUG_TYPE[b.type] || b.type);
  kv('创建', `${b.openedBy || ''}${b.openedDate ? ` · ${fmtDT(b.openedDate)}` : ''}`);
  kv('指派给', b.assignedTo);
  kv('截止', b.deadline ? String(b.deadline).slice(0, 10) : '未设置');
  if (b.resolution) kv('解决方案', RESOLUTION_LABEL[b.resolution] || b.resolution, true);
  if (b.resolvedBuild) kv('解决版本', b.resolvedBuild);
  if (b.resolvedBy) kv('解决人', b.resolvedBy);
  if (b.resolvedDate) kv('解决时间', fmtDT(b.resolvedDate));
  if (b.closedDate) kv('关闭时间', fmtDT(b.closedDate));
  if (b.storyTitle) kv('关联需求', b.storyTitle);
  if (b.taskName) kv('关联任务', b.taskName);
  if (grid.children.length) body.append(grid);

  body.append(el('div', 'dt-h', '重现步骤'));
  if (b.steps && b.steps.trim()) {
    const d = el('div', 'dt-desc');
    d.innerHTML = b.steps;
    body.append(d);
    fixImages(d);
  } else {
    body.append(el('div', 'dt-empty', '这条缺陷没写重现步骤'));
  }

  if (b.files && b.files.length) {
    body.append(el('div', 'dt-h', `附件 ${b.files.length}`));
    for (const f of b.files) {
      const line = el('div', 'dt-sub');
      line.append(el('span', 'sname', f.name));
      line.append(el('span', 'swho', f.url ? '浏览器打开' : '需登录'));
      line.addEventListener('click', () => f.url && window.zt.open(f.url));
      body.append(line);
    }
  }

  if (b.history && b.history.length) {
    body.append(el('div', 'dt-h', '动态'));
    const log = el('div', 'dt-log');
    for (const h of b.history) {
      const lg = el('div', 'lg');
      lg.append(el('b', null, h.actor || '系统'));
      lg.append(document.createTextNode(` ${fmtDT(h.date)}`));
      if (h.text) lg.append(el('div', null, h.text));
      if (h.comment) {
        const c = el('span', 'cmt');
        c.innerHTML = h.comment;
        lg.append(c);
      }
      log.append(lg);
    }
    body.append(log);
  }

  const foot = $('dt-foot');
  foot.replaceChildren();
  const act = st === 'active' ? ['resolve', '解决缺陷'] : st === 'resolved' ? ['close', '关闭缺陷'] : null;
  if (act) {
    const btn = el('button', 'btn primary', act[1]);
    btn.addEventListener('click', () => openBugAction(act[0], b));
    foot.append(btn);
  }
  const open = el('button', 'btn ghost', '浏览器打开');
  open.addEventListener('click', () => window.zt.open(b.url));
  foot.append(open);
  foot.hidden = false;
}

/* ---------------- toast ---------------- */

let toastTimer = null;

function toast(msg, kind) {
  const t = $('toast');
  t.className = `toast${kind ? ` ${kind}` : ''}`;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 2400);
}

function renderStatus() {
  const st = $('status');
  st.classList.remove('err');
  st.replaceChildren();
  st.title = '';

  const openTasks = S.items.filter((i) => i.kind !== 'bug' && !isDone(i)).length;
  const openBugs = S.items.filter((i) => i.kind === 'bug' && !isDone(i)).length;

  if (S.st.error) {
    st.classList.add('err');
    st.textContent = S.st.error;
    st.title = S.st.error;
  } else if (S.st.ok) {
    st.textContent = `${fmtClock(S.st.at)} · 任务 ${openTasks} · 缺陷 ${openBugs}`;
    if (S.st.bugWarn) st.title = `缺陷没拉下来：${S.st.bugWarn}`;
    else if (S.st.bugTruncated) st.title = '缺陷太多，只统计了最近一部分，剩下的去禅道看';
  } else {
    st.textContent = '等待刷新…';
  }

  $('count').textContent = String(openTasks + openBugs);
}

/* ---------------- 更新 ---------------- */

function renderUpdate() {
  const up = S.up || {};
  const bar = $('update-bar');
  const show = Boolean(up.downloading) || (up.hasUpdate && !S.upDismissed);
  bar.hidden = !show;

  const text = $('ub-text');
  const go = $('ub-go');

  if (up.downloading) {
    text.textContent = up.percent != null ? `正在下载更新 ${up.percent}%` : '正在下载更新…';
    go.hidden = true;
    go.disabled = true;
  } else if (show) {
    text.textContent = `新版本 ${up.latest}（当前 v${up.current || '—'}）`;
    text.title = up.notes || '';
    go.hidden = false;
    go.disabled = false;
    go.textContent = '更新';
  }

  // 设置面板里那行版本号
  const ver = $('ver-text');
  if (ver) ver.textContent = `当前版本 v${up.current || '—'}`;
}

function updateNote(msg, kind) {
  const box = $('ver-note');
  if (!box) return;
  box.hidden = !msg;
  box.className = `ver-note${kind === 'fail' ? ' fail' : ''}`;
  box.textContent = msg || '';
}

async function checkUpdateManual() {
  const btn = $('btn-check-update');
  btn.disabled = true;
  btn.textContent = '检查中…';
  updateNote('');
  try {
    const r = await window.zt.checkUpdate();
    S.up = r;
    renderUpdate();
    if (r.error) updateNote(r.error, 'fail');
    else if (r.hasUpdate) updateNote(`发现新版本 ${r.latest}，点底部「更新」即可`);
    else updateNote(`已是最新版本（v${r.current}）`);
  } catch (e) {
    updateNote(String(e.message || e), 'fail');
  } finally {
    btn.disabled = false;
    btn.textContent = '检查更新';
  }
}

async function doInstallUpdate() {
  const go = $('ub-go');
  go.disabled = true;
  go.textContent = '准备中…';
  try {
    const r = await window.zt.installUpdate();
    if (!r.ok) {
      toast(r.error || '更新失败', 'bad');
      go.disabled = false;
      go.textContent = '更新';
      return;
    }
    toast('下载完成，正在替换文件并重启…', 'ok');
  } catch (e) {
    toast(String(e.message || e), 'bad');
    go.disabled = false;
    go.textContent = '更新';
  }
}

function renderAll() {
  renderStatus();
  renderUpdate();
  syncPin();
  if (DT.open) return;
  renderList();
  requestAnimationFrame(autoHeight);
}

/** 窗口高度跟着内容走，别留一大片空 */
function autoHeight() {
  // 弹层打开时窗口尺寸由弹层自己定，别让列表把它缩回去
  if (!$('modal').hidden || !$('task-modal').hidden || !$('bug-modal').hidden) return;
  const list = $('list');
  let content;
  if (list.querySelector('.empty')) {
    content = 150;
  } else {
    content = 0;
    for (const child of list.children) content += child.offsetHeight + 4;
  }
  const chrome = 42 + 34 + 30 + 10 + ($('update-bar').hidden ? 0 : $('update-bar').offsetHeight); // titlebar + tabs + statusbar + 内边距 + 更新条
  window.zt.resize(Math.ceil(content + chrome));
}

/* ---------------- 动作 ---------------- */

function spin(on) {
  S.spinning = on;
  $('btn-refresh').classList.toggle('spin', on);
}

async function doRefresh() {
  if (S.spinning) return;
  spin(true);
  try {
    const r = await window.zt.refresh();
    apply(r);
  } finally {
    spin(false);
  }
}

function apply(payload) {
  if (!payload) return;
  if (payload.config) S.cfg = payload.config;
  if (payload.state) S.st = payload.state;
  if (payload.update) S.up = payload.update;
  S.items = Array.isArray(S.st.items) ? S.st.items : [];
  renderAll();
  if (S.cfg.baseUrl && !S.cfg.account && !$('modal').hidden) {
    /* noop */
  }
}

function syncPin() {
  $('btn-pin').classList.toggle('pinned', Boolean(S.cfg.alwaysOnTop));
  $('btn-pin').title = S.cfg.alwaysOnTop ? '已置顶（点击取消）' : '窗口置顶';
}

/* ---------------- 设置 ---------------- */

function openSettings() {
  $('f-baseUrl').value = S.cfg.baseUrl || '';
  $('f-account').value = S.cfg.account || '';
  $('f-password').value = S.cfg.password || '';
  $('f-intervalSec').value = S.cfg.intervalSec || 180;
  $('f-urlMode').value = S.cfg.urlMode || 'path';
  $('f-alwaysOnTop').checked = Boolean(S.cfg.alwaysOnTop);
  $('f-autoLaunch').checked = Boolean(S.cfg.autoLaunch);
  $('f-autoUpdate').checked = S.cfg.autoUpdate !== false;
  updateNote('');
  // 后台已经探到新版本的话，打开设置就把话说清楚，别让人自己去猜
  if (S.up && S.up.hasUpdate && S.up.latest) {
    updateNote(`发现新版本 ${S.up.latest}，点窗口底部的「更新」就能装`);
  } else if (S.up && S.up.error) {
    updateNote(S.up.error, 'fail');
  }
  renderUpdate();
  $('test-result').hidden = true;
  updateBaseHint();
  $('modal').hidden = false;
  // 设置面板比列表高不少，临时把窗口撑开，别让「保存」掉到滚动区外面
  window.zt.resize(660);
  $('f-baseUrl').focus();
}

function guessBase(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length && /\.(php\d?|html?)$/i.test(segs[segs.length - 1])) segs.pop();
    return `${u.protocol}//${u.host}${segs.length ? `/${segs.join('/')}` : ''}`;
  } catch {
    return s;
  }
}

function updateBaseHint() {
  const hint = $('base-hint');
  const raw = $('f-baseUrl').value.trim();
  if (!raw) {
    hint.classList.remove('bad');
    hint.textContent = '只填到端口/部署目录，index.php 会自动去掉';
    return;
  }
  const base = guessBase(raw);
  const fixed = base !== raw.replace(/\/+$/, '');
  hint.classList.toggle('bad', fixed);
  hint.textContent = fixed ? `会按这个地址连：${base}/api.php/v1/tokens` : `POST ${base}/api.php/v1/tokens`;
}

function closeSettings() {
  $('modal').hidden = true;
  requestAnimationFrame(autoHeight);
}

function readForm() {
  return {
    baseUrl: $('f-baseUrl').value.trim(),
    account: $('f-account').value.trim(),
    password: $('f-password').value,
    intervalSec: Math.max(30, Number($('f-intervalSec').value) || 180),
    urlMode: $('f-urlMode').value,
    alwaysOnTop: $('f-alwaysOnTop').checked,
    autoLaunch: $('f-autoLaunch').checked,
    autoUpdate: $('f-autoUpdate').checked,
  };
}

async function testConn() {
  const btn = $('btn-test');
  const box = $('test-result');
  btn.disabled = true;
  box.hidden = false;
  box.classList.remove('fail');
  box.textContent = '正在连…';
  try {
    const r = await window.zt.testConfig(readForm());
    if (r.ok) {
      box.textContent = `连上了 · ${r.ms}ms · ${r.baseUrl}`;
    } else {
      box.classList.add('fail');
      box.textContent = r.error || '连接失败';
    }
  } catch (e) {
    box.classList.add('fail');
    box.textContent = String(e && e.message ? e.message : e);
  } finally {
    btn.disabled = false;
  }
}

async function saveSettings() {
  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const r = await window.zt.saveConfig(readForm());
    closeSettings();
    apply(r);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并刷新';
  }
}

/* ---------------- 初始化 ---------------- */

function bind() {
  $('btn-refresh').addEventListener('click', doRefresh);
  $('btn-set').addEventListener('click', openSettings);
  $('btn-settings-link').addEventListener('click', openSettings);
  $('btn-hide').addEventListener('click', () => window.zt.minimize());
  $('btn-pin').addEventListener('click', async () => {
    const on = await window.zt.togglePin();
    S.cfg.alwaysOnTop = on;
    syncPin();
  });

  $('btn-close-modal').addEventListener('click', closeSettings);
  $('btn-test').addEventListener('click', testConn);
  $('btn-save').addEventListener('click', saveSettings);
  $('f-baseUrl').addEventListener('input', updateBaseHint);

  $('dt-back').addEventListener('click', closeDetail);
  $('dt-open').addEventListener('click', () => {
    if (DT.data) window.zt.open(DT.data.url || taskUrl(DT.data.id));
  });
  // 描述里的链接不要抢走挂件本身
  $('dt-body').addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href && /^https?:/i.test(href)) window.zt.open(href);
  });

  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) closeSettings();
  });

  $('tm-close').addEventListener('click', closeTaskAction);
  $('tm-cancel').addEventListener('click', closeTaskAction);
  $('tm-ok').addEventListener('click', confirmTaskAction);
  $('task-modal').addEventListener('click', (e) => {
    if (e.target === $('task-modal')) closeTaskAction();
  });

  $('bm-close').addEventListener('click', closeBugAction);
  $('bm-cancel').addEventListener('click', closeBugAction);
  $('bm-ok').addEventListener('click', confirmBugAction);
  $('bug-modal').addEventListener('click', (e) => {
    if (e.target === $('bug-modal')) closeBugAction();
  });

  $('tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    S.filter = t.dataset.filter;
    for (const b of $('tabs').children) b.classList.toggle('active', b === t);
    renderList();
    requestAnimationFrame(autoHeight);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('task-modal').hidden) return closeTaskAction();
      if (!$('bug-modal').hidden) return closeBugAction();
      if (!$('modal').hidden) return closeSettings();
      if (DT.open) return closeDetail();
    }
    if (e.key === 'F5') {
      e.preventDefault();
      doRefresh();
    }
  });

  window.zt.onState((s) => {
    S.st = s;
    S.items = Array.isArray(s.items) ? s.items : [];
    renderAll();
  });
  window.zt.onOpenSettings(openSettings);

  // 更新相关
  $('btn-check-update').addEventListener('click', checkUpdateManual);
  $('ub-go').addEventListener('click', doInstallUpdate);
  $('ub-close').addEventListener('click', () => {
    S.upDismissed = true;
    renderUpdate();
    requestAnimationFrame(autoHeight);
  });
  window.zt.onUpdate((s) => {
    S.up = s;
    renderUpdate();
    requestAnimationFrame(autoHeight);
  });
  window.zt.onOpenUpdate(() => {
    S.upDismissed = false;
    renderUpdate();
    requestAnimationFrame(autoHeight);
  });
}

(async function init() {
  bind();
  try {
    const boot = await window.zt.boot();
    apply(boot);
    const q = new URLSearchParams(location.search);
    if (q.has('setup') || !boot.config.baseUrl) openSettings();
  } catch (e) {
    $('status').textContent = `启动异常：${e.message || e}`;
  }
})();
