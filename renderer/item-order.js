'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ItemOrder = api;
})(globalThis, function () {
  const DONE = new Set(['done', 'closed', 'cancel']);
  const RANK = { overdue: 0, today: 1, soon: 2, later: 3 };

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(dateStr + 'T00:00:00');
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

  function compareItems(a, b, mode = 'priority') {
    if (mode === 'completed') {
      const ready = (item) => String(item.status || '').toLowerCase() === (item.kind === 'bug' ? 'resolved' : 'done');
      const completed = Number(ready(b)) - Number(ready(a));
      if (completed) return completed;
    }
    const priority = (a.pri || 9) - (b.pri || 9);
    if (priority) return priority;
    const ra = RANK[urgentOf(a)];
    const rb = RANK[urgentOf(b)];
    if (ra !== rb) return ra - rb;
    const da = a.deadline || '9999-12-31';
    const db = b.deadline || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    return 0;
  }

  return { daysUntil, urgentOf, isDone, compareItems };
});