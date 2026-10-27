/** 只为已公开的正式 Release 发送企微群通知；凭据由 Actions Secret 注入。 */
export async function notifyWecomRelease(release, webhookUrl) {
  if (!webhookUrl || release.draft || release.prerelease || !release.published_at) return false;

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: {
        content: `禅道挂件正式版已发布\n版本：${release.tag_name}\n下载与更新说明：${release.html_url}`,
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
