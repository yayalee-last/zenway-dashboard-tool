# 仓库工作指南

适用于本仓库所有目录。先阅读本文件、`README.md`、`package.json`、相关源码及 `.github/workflows/release.yml`；如果后续出现更深层 `AGENTS.md` 或 `.agents/skills/`，再读取与任务相关的指导。不要把历史提交说明当作当前实现。

## 项目与代码地图

项目是原生 HTML/CSS/JavaScript 的 Electron 桌面挂件，无前端框架、转译步骤或独立网页构建器。当前发布目标是 Windows x64。

| 路径 | 职责 |
| --- | --- |
| `electron/main.js` | 主入口；配置持久化、单实例、面板与托盘、轮询、IPC、富文本/图片、附件打开及更新编排 |
| `electron/zentao.js` | REST API v1、Token、任务/缺陷聚合与写操作、文件下载、地址清洗 |
| `electron/preload.js` | 通过 `contextBridge` 暴露 `window.zt` 的明确 IPC 方法 |
| `electron/floating-ball.js` | 悬浮球、常驻面板、前三项预览、多屏定位及显示切换 |
| `electron/preview-preload.js` | 预览专用的 `window.ztPreview` 桥接 |
| `electron/updater.js` / `apply-update.ps1` / `update-format.js` | GitHub 版本查询、包选择/校验、Windows 替换助手及包格式约定 |
| `renderer/index.html` / `app.js` / `style.css` | 主界面、列表/详情/设置/操作弹层、布局与用户动作 |
| `renderer/item-order.js` | UI 和主进程共用的排序、完成状态及截止日逻辑 |
| `renderer/floating-*.html` / `floating-preview.js` | 悬浮球与预览界面 |
| `electron/mock.js` | 有限范围的演示数据，不是全局网络/写入隔离 |
| `scripts/pack.mjs` / `electron-dist.mjs` | Windows x64 包、Electron 运行时获取及缓存 |
| `scripts/release.mjs` / `release-notify.mjs` / `ship.mjs` | 远端 Release 发布、可选企微通知、版本提交推送流程 |
| `scripts/make-icon.mjs` / `assets/` | 应用图标生成与图标资源 |
| `probe.mjs` / `zentao.config.example.json` | 独立真实接口探测工具及模板，与应用配置分离 |
| `test/` / `test/fixtures/` | Node 测试器、临时本地 HTTP 服务、Electron 界面和 Windows 更新 fixtures |

## 依赖与命令

- 依赖声明在 `package.json`，提交锁文件 `package-lock.json`。Electron 当前锁定为 45.0.0，npm 包要求 Node.js >= 22.12.0；CI 使用 Node.js 22。用 `npm ci` 安装，不要凭经验改依赖范围/版本或手工重写锁文件。
- `npm start` 会启动实际应用，读取用户数据并可能访问真实禅道；不是无副作用检查。
- `npm run pack` 只构建 Windows x64 目标，可能下载 Electron、清空 `release/`、重写二进制资源；不能作为纯静态检查。跨平台构建能力不等于 Linux/macOS 运行行为已验证。
- `npm run icon` 会改图标资源；`npm run probe` 会创建/读取本地配置、访问真实服务并输出业务数据。只在任务需要且有相应授权时执行。
- `npm run release` / `npm run ship` 是发布命令，不能用来验证普通改动。`ship` 默认升版本、`git add -A`、提交、推送后发布；无令牌也可能提交/推送。`--no-push` 不禁止 Release 发布，`--dry` 才只打印计划。
- 保持现有 CommonJS（Electron/多数测试）和 ESM（`.mjs` 脚本）边界；源码一般采用两空格、单引号、分号。没有配置格式化器，不要在小改动中批量重排无关代码。

## 修改与验证

1. 先确认需求和修改范围；只编辑相关文件。不要将本机配置、缓存、截图、安装产物或秘密加入提交。
2. 先检查脚本、依赖和 fixtures，再决定是否安装或执行；不需要的 GUI、真实网络和发布操作不运行。
3. 可以用 `node --check <文件>` 做 JS/CJS/MJS 语法检查；它不会启动 Electron，但也不证明行为正确。
4. 仓库**有现成测试**，但没有 `npm test`、lint、typecheck 脚本。完整验证应沿用 CI 的命令，而非虚构不存在的命令：

   ```sh
   node -e "require('electron')"
   node --test test/attachments.test.cjs test/task-actions.test.cjs test/updater.test.cjs test/update-check.test.cjs test/window.test.cjs test/release-notify.test.mjs test/release-publish.test.mjs
   ```

   该准备命令会解析/准备 Electron 运行时，并非完整安装替代。附件用例含真实 Electron UI，需 GUI；窗口和部分更新用例有 Windows 平台限制，Linux 跳过不算验证了 Windows 行为。
5. 相关测试覆盖：附件权限/下载/本地打开与 preload，开始任务保留指派人和任务关闭/排序，更新检查调度与应用包校验/回滚，浮球/面板窗口生命周期与位置，以及模拟 Release/企微通知。用 fixtures 和临时目录扩展测试，禁止接入真实账号来跑写操作。
6. 只检查发布逻辑时可独立运行 `node --test test/release-notify.test.mjs test/release-publish.test.mjs`；这些测试模拟 `fetch`，不实际创建 Release/发送企微通知。不得将该局部通过描述为全套或 Windows UI 通过。
7. UI/窗口变更应验证重复点击、取消/关闭、详情返回、刷新、设置开关、模式切换、托盘恢复和多屏边界；无法在 Windows GUI 验证时如实记录，不用静态检查代替。
8. 代码行为变更更新 `CHANGELOG.md` 的「未发布」，用户命令/配置/功能边界变化同步 README；架构或验证约定变化同步本文件。只记录实际改动和可追溯历史，不编造版本、测试通过或兼容性。
9. 交付说明分清已通过、失败、跳过和未运行项目，给出环境/原因。普通 PR 不自动运行当前发布 job，不可仅因没有失败检查就宣称 CI 全绿。

## IPC 与外部内容边界

- 主进程持有网络、文件系统、托盘和系统打开权限；renderer 通过 preload 的窄接口请求，不直接引入 Node、不暴露通用 IPC/任意命令执行通道。
- 保持 `contextIsolation: true`、`nodeIntegration: false`。当前主面板 `sandbox: false`，浮球/预览 `sandbox: true`；不要写成全应用都已沙箱化，也不要为方便调试进一步放宽限制。
- 扩展 IPC 时明确校验消息来源、输入类型/范围和权限。renderer 的 URL、路径、名称、ID、动作和配置补丁均是不可信输入；不要照搬现有宽松处理作为新代码标准。
- 附件打开必须由主进程回查任务/缺陷详情及文件归属，只采用服务端返回的文件名并清洗，在独立临时目录保存，通过 Token 下载，禁止带鉴权头跨站重定向；不接受 renderer 任意路径/下载 URL。保留失败清理和明确错误提示。
- 富文本来自服务端。当前正则清洗不是完整 HTML 安全消毒器，CSP 允许远程图片；修改描述、评论、链接或图片路径时防止脚本、伪协议、非预期导航和凭据泄漏，不宣称已彻底消除风险。
- 链接只交受控 HTTP/HTTPS 系统浏览器入口；附件会调用系统默认程序，测试要替换该能力，不实际打开不可信文件。

## 凭据、配置与真实服务

- 应用配置是 `app.getPath('userData')/config.json`，根目录 `zentao.config.json` 仅供 probe。应用不会自动读取根目录模板。
- 当前密码明文持久化，`publicConfig()` 也会把密码发给 renderer；不得声称加密或仅主进程可见。代码改动不顺便迁移/删除用户数据，除非任务明确要求。
- 保持 `.gitignore` 对本地配置和产物的排除。只用占位值/fixtures，提交前检查 diff，禁止记录真实密码、Token、内网地址、webhook、请求头或完整用户数据。不要读取无关凭据或绕过认证。
- 不用真实禅道执行开始/完成/关闭任务、解决/关闭缺陷的自动化验证；需要真实联调时先获得明确授权，限定测试对象和动作，不自行创建或修改生产数据。
- `--mock` 仅替换部分刷新和缺陷流程；任务动作、配置测试、附件和更新等仍可能连真实服务。隔离测试应使用 fixtures、临时用户目录和明确替身，不把该参数当安全开关。
- probe 当前仅认 Token 响应 200，而主客户端接受 200/201；诊断时分清工具误报和应用故障，不为文档任务顺便改代码。
- 自动更新/发版涉及可执行文件、远端状态和 Secret。保留运行时/平台/架构/版本/摘要校验、失败回滚及发布状态核对；不修改更新源、触发 release workflow、发送企微通知、推送发布提交或执行 Release，除非属于明确授权范围。

## 提交与发布约定

- 采用描述性提交信息；纯文档提交用 `docs:` 等，不使用 `release:` 前缀或改软件版本来触发发版。
- 发布工作流只在 `main` 上的 `release:` 提交或手动运行时执行发布 job，测试后发布 Windows 包。不要将其改写成已有普通 PR CI 的表述。
- 只提交已审核范围内文件；核对远端分支、提交和检查状态后再报告。需要 PR 时默认草稿，不自行合并、部署或启用自动合并。
- 当前无 LICENSE；未经维护者决定不要加入或假定许可证。
