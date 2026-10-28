'use strict';

// This is a client-side request boundary, not a claim about arbitrary server semantics.
function positiveId(value, label = '对象') {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) {
    throw new Error(`${label}编号无效`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label}编号无效`);
  return id;
}

function assertRestOperation(method, path) {
  if (typeof path !== 'string' || !['GET', 'POST'].includes(method) || /[\s\\#]/.test(path)) {
    throw new Error('已阻止未授权的禅道请求（禁止删除）');
  }
  const [route, search, extra] = path.split('?');
  if (extra !== undefined) throw new Error('禅道请求地址无效');
  const id = '[1-9][0-9]*';
  let keys = [];
  if (method === 'POST') {
    if (search !== undefined || !new RegExp(`^/api\\.php/v1/(?:tokens|tasks/${id}/(?:start|finish|close)|bugs/${id}/(?:resolve|close))$`).test(route)) {
      throw new Error('已阻止未授权的禅道写操作（禁止删除）');
    }
  } else if (/^\/api\.php\/v1\/(projects|executions|products)$/.test(route)) keys = ['page', 'recPerPage'];
  else if (route === '/api.php/v1/tasks') keys = ['page', 'recPerPage', 'assignedTo'];
  else if (new RegExp(`^/api\\.php/v1/executions/${id}/tasks$`).test(route)) keys = ['status', 'recPerPage', 'page'];
  else if (new RegExp(`^/api\\.php/v1/products/${id}/bugs$`).test(route)) keys = ['page', 'recPerPage'];
  else if (!new RegExp(`^/api\\.php/v1/(?:tasks|bugs|files)/${id}$`).test(route)) throw new Error('已阻止未授权的禅道读取请求');
  for (const segment of route.split('/')) if (/^\d+$/.test(segment)) positiveId(segment);
  if (search !== undefined) {
    if (!search) throw new Error('禅道查询参数无效');
    const seen = new Set();
    for (const entry of search.split('&')) {
      const match = /^([a-zA-Z]+)=([^&]*)$/.exec(entry);
      if (!match || !keys.includes(match[1]) || seen.has(match[1])) throw new Error('禅道查询参数不在允许范围');
      seen.add(match[1]);
      let value;
      try { value = decodeURIComponent(match[2]); } catch { throw new Error('禅道查询参数编码无效'); }
      if (match[1] === 'assignedTo') {
        if (!value || value.length > 100 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('账号查询参数无效');
      } else if (match[1] === 'status') {
        if (value !== 'assignedtome') throw new Error('任务状态查询参数无效');
      } else if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 10000) throw new Error('分页参数无效');
    }
  }
  return path;
}

module.exports = { positiveId, assertRestOperation };
