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

function decodedUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.trim()) return null;
  let decoded = value;
  // Bounded decoding catches common legacy route evasions; deeper/ambiguous encodings fail closed.
  for (let i = 0; i < 3; i++) {
    decoded = decoded.replace(/&(?:amp|colon|sol|bsol|quest|equals|num|tab|newline|#\d+|#x[\da-f]+);/gi, entity => {
      const code = entity.slice(1, -1).toLowerCase();
      if (code.startsWith('#')) {
        const n = code[1] === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return n <= 0x10ffff ? String.fromCodePoint(n) : '\u0000';
      }
      return { amp: '&', colon: ':', sol: '/', bsol: '\\', quest: '?', equals: '=', num: '#', tab: '\t', newline: '\n' }[code];
    });
    if (/[\u0000-\u001f\u007f\\]/.test(decoded) || (i === 0 && /\s/.test(decoded))) return null;
    let next;
    try { next = decodeURIComponent(decoded); } catch { return null; }
    if (next === decoded) return decoded;
    decoded = next;
  }
  if (/%[\da-f]{2}|&(?:#?\w+);/i.test(decoded) || /[\u0000-\u001f\u007f\\]/.test(decoded)) return null;
  return decoded;
}

function safeExternalUrl(value) {
  const decoded = decodedUrl(value);
  if (!decoded) return false;
  let url;
  try { url = new URL(decoded); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  // ZenTao supports both /task-delete-1.html and ?m=task&f=delete. Check every
  // occurrence rather than URLSearchParams.get(), which misses polluted parameters.
  const destructive = /(?:^|[^a-z])(?:batch)?(?:delete[a-z]*|undelete[a-z]*|remove[a-z]*|erase|purge|trash)(?:$|[^a-z])/i;
  if (destructive.test(url.pathname) || destructive.test(url.hash)) return false;
  // PHP deployments can accept ';' separators and trim leading spaces from names.
  const selectors = new URLSearchParams(url.search.slice(1).replace(/;/g, '&'));
  for (const [key, val] of selectors) {
    // Only action selectors are executable. Search terms, assignees and filenames
    // can legitimately contain words such as "delete".
    const name = key.replace(/^ +/, '').replace(/\[.*$/, '');
    if (/^(?:f|action|method|_method|function|func|op|operation|cmd)$/i.test(name) && destructive.test(val)) return false;
  }
  return true;
}

// No credentials are attached here. Explicit redirects preserve ordinary public download
// redirects while checking each destination before the next network request.
async function safePublicFetch(url, init = {}) {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!safeExternalUrl(current)) throw new Error('已阻止不安全的外部请求');
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error('外部请求重定向无效或次数过多');
    current = new URL(location, current).href;
  }
}

module.exports = { positiveId, assertRestOperation, safeExternalUrl, safePublicFetch };
