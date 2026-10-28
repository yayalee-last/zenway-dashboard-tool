'use strict';

const { positiveId } = require('./request-safety');

function actionPayload(kind, action, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('操作参数无效');
  const fields = kind === 'task'
    ? { start: ['consumed', 'left', 'realStarted', 'comment'], finish: ['currentConsumed', 'left', 'realStarted', 'finishedDate', 'comment'], close: ['comment'] }
    : { resolve: ['resolution', 'resolvedBuild', 'comment', 'assignedTo', 'duplicateBug'], close: ['comment'] };
  if (!fields[action] || Object.keys(input).some(key => !fields[action].includes(key))) throw new Error('操作参数不在允许范围');
  const out = { ...input };
  for (const key of ['comment', 'assignedTo', 'resolution', 'resolvedBuild', 'realStarted', 'finishedDate']) {
    if (out[key] !== undefined && (typeof out[key] !== 'string' || out[key].length > (key === 'comment' ? 20000 : 200) || /[\u0000\u007f]/.test(out[key]))) throw new Error('操作文本参数无效');
  }
  for (const key of ['consumed', 'currentConsumed', 'left']) {
    if (out[key] !== undefined && (typeof out[key] !== 'number' || !Number.isFinite(out[key]) || out[key] < 0 || out[key] > 1000000)) throw new Error('工时必须是有效的非负数字');
  }
  for (const key of ['realStarted', 'finishedDate']) {
    if (out[key] !== undefined && (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(out[key]) || !Number.isFinite(new Date(out[key]).getTime()))) throw new Error('任务时间格式无效');
  }
  if (kind === 'task' && action === 'start') {
    out.consumed ??= 0;
    out.left ??= 0;
    if (out.left <= 0) throw new Error('开始任务的剩余工时必须大于 0；禅道 22.6 会将剩余为 0 的开始操作直接完成。若已完成，请到禅道网页核对或完成');
  }
  if (kind === 'task' && action === 'finish') {
    out.currentConsumed ??= 0;
    if (out.left !== undefined && out.left !== 0) throw new Error('完成任务的剩余工时必须为 0');
  }
  if (kind === 'bug' && action === 'resolve') {
    out.resolution ??= 'fixed';
    out.resolvedBuild ??= 'trunk';
    if (!['fixed', 'bydesign', 'duplicate', 'external', 'notrepro', 'postponed', 'willnotfix', 'tostory'].includes(out.resolution)) throw new Error('解决方案无效');
    if (!out.resolvedBuild.trim()) throw new Error('解决版本不能为空');
    if (out.duplicateBug !== undefined) out.duplicateBug = positiveId(out.duplicateBug, '重复缺陷');
    if (out.resolution === 'duplicate' && !out.duplicateBug) throw new Error('重复缺陷需要指定有效编号，请在禅道网页处理');
  }
  if (action === 'close') out.comment ??= '';
  return out;
}

// Preserve the widget's existing narrow flow; server roles, parent/team rules and
// plugin permissions remain enforced by ZenTao, not invented client-side.
function applicableAction(kind, action, record) {
  const states = kind === 'task' ? { start: 'wait', finish: 'doing', close: 'done' } : { resolve: 'active', close: 'resolved' };
  return Boolean(record && record.status === states[action] &&
    [false, 0, '0'].includes(record.deleted));
}

module.exports = { actionPayload, applicableAction };
