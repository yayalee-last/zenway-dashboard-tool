'use strict';

// REST deployments return assignees as either account strings or user objects.
function accountOf(task) {
  const value = task && task.assignedTo;
  const account = typeof value === 'string' ? value : value && value.account;
  return typeof account === 'string' ? account.trim() : '';
}

function isMine(task, account) {
  const owner = accountOf(task).toLowerCase();
  const me = typeof account === 'string' ? account.trim().toLowerCase() : '';
  return Boolean(owner && me && owner === me);
}

function assigneeName(task) {
  const value = task && task.assignedTo;
  const name = task && (task.assignedToRealName || task.assignedToRealname)
    || (value && typeof value === 'object' && value.realname);
  return typeof name === 'string' && name.trim() ? name.trim() : accountOf(task);
}

function taskChildren(task) {
  const value = task && task.children;
  if (!value || typeof value !== 'object') return { state: 'unavailable', children: [] };
  const children = [];
  const seen = new Set();
  let partial = false;
  for (const [key, child] of Object.entries(value)) {
    const id = child && Number(child.id == null && !Array.isArray(value) ? key : child.id);
    if (!child || typeof child !== 'object' || Array.isArray(child) || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) {
      partial = true;
      continue;
    }
    seen.add(id);
    children.push({ ...child, id });
  }
  return { state: partial ? 'partial' : 'supplied', children };
}

function isParentTask(task, children = taskChildren(task)) {
  return Number(task && task.isParent) > 0 || Number(task && task.parent) === -1 || children.children.length > 0;
}

module.exports = { accountOf, isMine, assigneeName, taskChildren, isParentTask };
