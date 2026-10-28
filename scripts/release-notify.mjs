/** 只为已公开的正式 Release 发送企微群通知；凭据由 Actions Secret 注入。 */
export async function notifyWecomRelease(release, webhookUrl) {
  if (!webhookUrl || release.draft || release.prerelease || !release.published_at) return false;
  let notes = (release.body || '').trim();
  if (!notes) throw new Error('正式版缺少更新内容，未发送企微通知');
  const heading = `禅道挂件正式版已发布\n版本：${release.tag_name}\n本次更新：\n`;
  const footer = `\n下载与完整更新说明：${release.html_url}`;
  const budget = 2048 - Buffer.byteLength(heading + footer, 'utf8');
  if (Buffer.byteLength(notes, 'utf8') > budget) {
    const suffix = '\n…更新内容较长，完整内容见链接';
    let summary = '';
    let bytes = 0;
    for (const character of notes) {
      const width = Buffer.byteLength(character, 'utf8');
      if (bytes + width > budget - Buffer.byteLength(suffix, 'utf8')) break;
      summary += character;
      bytes += width;
    }
    notes = summary.trimEnd() + suffix;
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: {
        content: heading + notes + footer,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    // 网络异常可能带完整请求地址，不能将含 key 的原始错误写进公开日志。
    throw new Error('企微请求失败或超时，请检查网络及 WECOM_WEBHOOK_URL');
  });
  if (!response.ok) throw new Error(`企微返回 HTTP ${response.status}`);
  const result = await response.json().catch(() => {
    throw new Error('企微返回了无效 JSON');
  });
  if (result.errcode !== 0) throw new Error(`企微返回错误码 ${Number(result.errcode)}`);
  return true;
}
