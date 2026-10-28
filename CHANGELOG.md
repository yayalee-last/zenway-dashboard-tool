# 变更记录

以下按 Git 提交和现有版本标签倒序整理，日期采用提交的 UTC 日期。此文件不是测试报告，也不将提交记录等同于已下载验证的发行包；早期未打标签的开发阶段单独列出。历史提交中重复使用的版本号合并在相应条目下。

## 未发布

### 修复

- 按开源禅道 22.6 接口修正任务/缺陷关闭备注（显式空 `comment`），避免仅传 `closedReason` 不进入关闭处理；完成使用本次消耗字段并保留已有开始时间。
- 开始任务的消耗改为累计工时提示，默认使用已有累计值；写前检查累计下限和正剩余工时，拦截 22.6 中「开始且剩余为 0」会自动完成、改派而从个人列表消失的误操作。
- 请求层新增方法、规范路由/查询白名单与正整数编号校验；禁止 DELETE、非允许动作、已知旧式删除链接和不安全鉴权重定向，链接/图片/公开更新下载增加同类边界。
- 任务和缺陷动作在主进程校验来源、参数、最新状态，保留自己任务限制及服务器缺陷权限；状态失效不写入、不自动改换动作。回查失败/空值/错误编号/意外状态明确为未知，不再误报成功；写请求不自动重发。
- 处理中的同一记录禁止重复提交，取消/重开及旧异步回复不覆盖新操作框；未知结果需先查最新详情/网页，连接配置不能在操作中途切换。补充去敏字段错误、完成后隐藏及关闭不等于删除的说明和合成回归。
- 关闭已完成任务的确认框保留较高的列表/详情窗口，短列表才增高至确认框所需尺寸，避免收缩后原点击指针落在窗口外、触发悬浮面板意外隐藏；保留取消/确认、返回页面和鼠标移出收起规则，并增加隔离回归。
- 正式发布默认从 CHANGELOG 对应版本提取完整说明，企微通知附上本次更新内容及下载链接；缺失说明时停止，长正文保留摘要和完整说明链接。
- 增加明确手动触发的已发布版本说明补全与单次通知入口，复用现有 Actions Secret，不重新打包或创建版本。

## [0.3.13](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.12...v0.3.13) — 2026-10-28

### 修复

- 父任务展开和任务详情展示本次接口可见的所有子任务（包含其他负责人），显示负责人、状态、剩余工时及「我/参考」标记；不将参考条目并入首页个人待办或计数。
- 点击列表展开的子任务直接在挂件内打开详情，保留参考任务只读限制；可返回列表或从详情底部打开禅道网页。
- 兼容字符串/用户对象负责人、数组/ID 对象子任务及已知父任务标记；缺失、异常或不完整的子任务数据明确提示，不再误报为空。缺少父任务标记时提供按需查看入口，不逐条自动抓详情。
- 他人或负责人无法确认的任务详情只读；任务写操作在主进程校验来源、ID/动作并重新核对当前负责人，拒绝伪造前端标记或写前回查时已不再指派给自己的请求，保留自己任务的开始/完成/关闭及父任务导航。
- 新增隔离的实际 IPC handler/renderer fixtures，覆盖可见子任务、空/缺失/异常响应、负责人和操作保护、重复展开/返回及个人计数边界。

### 文档

- 补充 README：启动、两种配置文件、功能边界、Windows 打包/更新、验证命令与安全注意事项。
- 新增根目录 AGENTS.md：代码地图、开发和验证约定、凭据及真实接口操作边界。
- 根据已有 Git 历史建立本变更记录。

## [0.3.12](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.11...v0.3.12) — 2026-10-27

- 已完成任务增加关闭入口及确认操作；支持保存按等级/已完成优先排序，排序栏只在「全部」分类显示，前三条预览使用相同排序（[07e01f4](https://github.com/yayalee-last/zenway-dashboard-tool/commit/07e01f478fb63db7eafd5a8542e51ff5f37e4251)）。
- 发布公开请求遇到异常时先核对真实 Release 状态，再决定后续通知；增加相关模拟回归用例（[5050eee](https://github.com/yayalee-last/zenway-dashboard-tool/commit/5050eee5760d2586e340f3f5a5ebe841141fab4c)）。

## [0.3.11](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.10...v0.3.11) — 2026-10-27

- 增加前三项待办预览、左右自动换边和悬浮球/常驻完整面板模式切换，移除「今天」分类。
- 修正常驻面板模式的悬浮球显隐，以及拖动后打开详情/设置的坐标保持；增加窗口回归用例。
- 正式版发布成功后，可通过 `WECOM_WEBHOOK_URL` 发送企微通知。
- 版本标签对应 [61ca762](https://github.com/yayalee-last/zenway-dashboard-tool/commit/61ca7621b28ab3fdea94f1af27024f947891007c)，功能改动在该版本范围内的前序提交中。

## [0.3.10](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.9...v0.3.10) — 2026-10-27

- 增加桌面悬浮球与悬停展开面板（[e83c136](https://github.com/yayalee-last/zenway-dashboard-tool/commit/e83c136c19b19fc9ad444877e55d12f7a352e6dc)）。

## [0.3.9](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.8...v0.3.9) — 2026-10-27

- 统一石墨灰与暖金界面、共享 SVG 图标、应用和托盘标识；列表高度按实际布局计算（[c8164ea](https://github.com/yayalee-last/zenway-dashboard-tool/commit/c8164ea1ae9abe99aeab608bffcdd01ff6f400e0)）。

## [0.3.8](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.7...v0.3.8) — 2026-10-27

- 开始任务前读取并保留原指派人，避免开始后任务从个人列表消失（[faa09f7](https://github.com/yayalee-last/zenway-dashboard-tool/commit/faa09f7bf892ae6670a00f1703ea8894d505e487)）。

## [0.3.7](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.6...v0.3.7) — 2026-10-27

- 按实际文件 ID 对象整理任务/缺陷附件，通过 Token 下载后交系统默认程序打开，补充读取、下载和打开失败提示及附件测试（[b1345a7](https://github.com/yayalee-last/zenway-dashboard-tool/commit/b1345a7238e4c731d792cbe22d2a607c3e2e5025)）。
- CI 提前准备 Electron 运行时，避免并行测试下载冲突；现有 `v0.3.7` 标签位于此后续提交（[5fc8017](https://github.com/yayalee-last/zenway-dashboard-tool/commit/5fc801724cdfbbbd751299b088cda7cec4ce7876)）。

## [0.3.6](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.5...v0.3.6) — 2026-10-27

- 修复更新检查使详情窗口突然缩小的问题（[d51cdd2](https://github.com/yayalee-last/zenway-dashboard-tool/commit/d51cdd272ac01d10f04f5f08af7ea6e7ae04c66b)）。

## [0.3.5](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.4...v0.3.5) — 2026-10-26

- 自动检查新版本的间隔调整为每 5 分钟，并显示更新提示（[d2282c3](https://github.com/yayalee-last/zenway-dashboard-tool/commit/d2282c36fcf39af9f06e2cf2246959a61a64ac48)）。

## [0.3.4](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.3...v0.3.4) — 2026-10-26

- 修复 Windows 窗口置顶失效，补充窗口恢复验证用例（[264c04a](https://github.com/yayalee-last/zenway-dashboard-tool/commit/264c04a51cf041e42d0c572e0867e59c651cd7de)）。

## [0.3.3](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.2...v0.3.3) — 2026-10-26

- 设置入口显示当前版本，便于核对更新（[b50b44d](https://github.com/yayalee-last/zenway-dashboard-tool/commit/b50b44df4744e239413689375245c9cb63d26c03)）。

## [0.3.2](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.1...v0.3.2) — 2026-10-26

- 引入运行时匹配时的应用小包更新及不匹配时的完整包回退；更新助手按 PID 限时等待，替换失败时回滚（[07c8d74](https://github.com/yayalee-last/zenway-dashboard-tool/commit/07c8d749e5580844af8ba9160045ea4131c46908)）。
- 修复 Windows 验证目录清理竞争，`v0.3.2` 标签位于该后续提交（[6606af0](https://github.com/yayalee-last/zenway-dashboard-tool/commit/6606af02fb4e52dd27cb7210a4e2d1e2f919907b)）。

## [0.3.1](https://github.com/yayalee-last/zenway-dashboard-tool/compare/v0.3.0...v0.3.1) — 2026-10-26

- 标题栏增加版本提醒入口（[30b73ce](https://github.com/yayalee-last/zenway-dashboard-tool/commit/30b73ce43243021321bddef8ede187d431b12aa3)）。

## [0.3.0](https://github.com/yayalee-last/zenway-dashboard-tool/tree/v0.3.0) — 2026-10-26

- 增加指派给自己的缺陷列表、详情、解决/关闭操作，以及登录 HTML 响应后的 Token 重取（[15c5c85](https://github.com/yayalee-last/zenway-dashboard-tool/commit/15c5c85c387424ef452ca1640f054a03d53945b2)）。
- 增强更新入口、加入一键发版脚本；随后迁移至 GitHub Releases 并启用自动发版（[b083fd9](https://github.com/yayalee-last/zenway-dashboard-tool/commit/b083fd92ef52fcc8ced25efd960c1fb2a428116e)）。

## 早期开发阶段（未建立对应版本标签）— 2026-10-26

- 初始 Electron 无边框桌面挂件、REST v1 Token 认证、个人任务聚合、详情和任务操作、托盘及设置（[2053c70](https://github.com/yayalee-last/zenway-dashboard-tool/commit/2053c70f9dda7fbe4db83545c0b672a792c20b58)）。
- 增加 Windows x64 绿色版打包、图标与版本资源，改进产物占用时的清理提示，并去除配置模板里的具体内网地址。
- 增加早期 Gitee Releases 自动更新；[4242f56](https://github.com/yayalee-last/zenway-dashboard-tool/commit/4242f563c1c9a15c6cbd1bde08b76f4dcb423c7b) 的提交记录了版本从 0.1.0 到 0.2.0 的调整。此项仅记录历史，不代表当前更新源仍为 Gitee。
