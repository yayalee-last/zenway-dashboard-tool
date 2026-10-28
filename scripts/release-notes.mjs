/** 只提取目标版本章节，保留小标题和正文，不混入未发布或其他版本内容。 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG 缺少 ${version} 的更新内容`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const notes = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
  if (!notes) throw new Error(`CHANGELOG 中 ${version} 的更新内容为空`);
  return notes;
}
