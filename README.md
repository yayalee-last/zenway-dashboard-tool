# 禅道桌面待办挂件

用 Electron 将指派给自己的禅道任务、缺陷放到桌面。默认显示悬浮球，悬停展开待办面板，也可以切换为常驻完整面板。

当前源码版本：`0.3.14`。本项目使用禅道 REST API v1；不是禅道网页的完整替代，也不是实时推送客户端。

## 能做什么

- 定时或手动刷新任务、缺陷，提供「未完成 / 缺陷 / 逾期 / 全部」分类。
- 显示任务工时、父子任务、描述、最近动态，以及缺陷重现步骤、附件等详情；展开父任务/任务详情可看本次接口允许查看的子任务、负责人、状态和剩余工时，标明「我」或「参考」。
- 开始、完成、关闭已完成任务；解决、关闭缺陷。**这些操作会修改真实禅道数据**，受服务端权限、状态和字段要求约束。
- 「全部」分类可选择按等级或已完成优先排序，保存选择并同步悬浮球前三条待办预览。缺陷「已解决」仍算未关闭待办。
- 开始、完成或关闭任务时显示操作弹窗；弹窗打开期间移出鼠标不会自动收起，提交失败继续保留。取消、关闭、Esc、点击遮罩或提交成功后恢复原页面与正常收起。关闭确认框保留较高的列表/详情窗口，只在空间不足时增高。
- 禅道 22.6 中，开始任务时将剩余工时填为 0 会直接标为已完成；挂件按回查状态显示「已完成」，需要保持进行中时应填写实际剩余工时。
- 托盘常驻、窗口置顶、位置记忆、开机自启设置、悬浮球和常驻面板切换。
- 从 GitHub Releases 检查新版本，用户点击更新后下载、替换并重启 Windows 绿色版。

没有系统级到期通知、离线编辑或多账号切换功能。列表来自轮询，不能当作实时或完整的审计记录。

## 安装与启动

### Windows 绿色版

从本仓库 [Releases](https://github.com/yayalee-last/zenway-dashboard-tool/releases) 下载 `ZentaoWidget-win32-x64.zip`，**完整解压**后运行目录中的 `ZentaoWidget.exe`，不要只复制 exe，也不要在压缩包内直接运行。

当前打包脚本只产出 **Windows x64** 绿色版；打包时修改 exe 资源后原 Electron 签名会失效，脚本没有重新签名。请只使用信任的来源，按组织安全策略处理系统提示，不要关闭安全软件。

### 从源码启动

开发依赖中的 Electron 锁定为 `45.0.0`（声明范围为 `^45.0.0`），其 npm 包要求 **Node.js >= 22.12.0**；发布 CI 使用 Node.js 22。仓库本身未声明 `engines`，优先使用符合上述要求的 Node.js 22 和随附 npm。

```sh
git clone https://github.com/yayalee-last/zenway-dashboard-tool.git
cd zenway-dashboard-tool
npm ci
npm start
```

`npm ci` 根据锁文件安装开发依赖，并可能下载当前平台的 Electron 运行时；需要访问锁文件中的 npm 源和 Electron 下载源。不要使用 `--omit=dev`，Electron 也在开发依赖中。Windows 还可双击 `start.cmd`；该脚本要求 `node_modules/electron/dist/electron.exe` 已存在，并清除 `ELECTRON_RUN_AS_NODE` 后启动。

源码可在其他平台尝试启动，但仓库没有提供 Linux/macOS 安装包或相应的完整运行验证；自启、托盘、透明窗口、置顶、多屏和更新行为不能据此视为已支持。

## 首次连接禅道

1. 悬停悬浮球展开面板，点击设置；也可从托盘菜单进入「设置…」。源码启动时可用 `npm start -- --setup` 直接打开设置。
2. 填部署根地址，例如 `https://zentao.example.com/zentao`，不要填 REST 端点或某个任务页面。代码会清理常见的 `index.php` / `.html` 页面后缀。
3. 填禅道登录账号和密码。账号需能使用 `/api.php/v1`，并拥有相应任务、执行、产品和缺陷的访问权限。
4. 选择链接格式：普通查询参数 `index.php?m=task…`，或服务端配置了伪静态时使用 `/task-view-1.html`。这只影响打开网页的链接，不改变 REST API 路径。
5. 先点击「测试连接」，再点击「保存并刷新」。连接测试会创建登录 Token 并读取执行列表，不会替你修改任务，但也不证明所有产品、附件或写操作权限可用。

默认刷新间隔为 180 秒，最短 30 秒。关闭/收起面板不等于退出程序：托盘仍常驻，默认悬浮球仍可展开；需要停止轮询时从托盘选择「退出」。

### 配置文件的区别

| 文件 | 用途 |
| --- | --- |
| Electron `app.getPath('userData')` 下的 `config.json` | 挂件实际读取和保存的配置；Windows 通常为 `%APPDATA%/zentao-widget/config.json` |
| 仓库根目录 `zentao.config.example.json` | 接口探测配置模板，不会自动导入挂件 |
| 仓库根目录 `zentao.config.json` | `npm run probe` 专用的本地配置，不是挂件配置 |

一般只需使用设置面板。手动编辑应用配置前先退出挂件并备份；内容必须是合法 JSON。以下仅是占位示例，不包含真实凭据：

```json
{
  "baseUrl": "https://zentao.example.com/zentao",
  "account": "your-account",
  "password": "replace-locally",
  "urlMode": "get",
  "intervalSec": 180,
  "alwaysOnTop": true,
  "autoLaunch": false,
  "autoUpdate": true,
  "displayMode": "ball",
  "showTopThree": false,
  "previewSide": "left",
  "sortMode": "priority"
}
```

- `displayMode`：`ball` 悬浮球，`panel` 常驻完整面板；`showTopThree` 开启球旁前三条未完成待办预览（已完成任务不进入预览，已解决但未关闭缺陷仍进入），`previewSide` 可为 `left` / `right`，空间不足时自动换边。
- `sortMode`：`priority` / `completed`。默认先比较优先级，再比较逾期/今天/三天内/其他及截止日；已完成优先模式先前置已完成任务和已解决缺陷。
- 客户端另可读取 `concurrency`（默认 8，限制 1–16）和 `timeoutMs`（默认 15000，最低 3000）；设置界面不提供这两项。模板中的 `maxExecutions` 仅供 probe 使用，不是挂件的执行数量上限。

## 数据覆盖与已知限制

- 任务先尝试全局 `/tasks?assignedTo=...`；不满足条件时遍历非关闭、非挂起的执行，读取 `status=assignedtome`。执行、项目、产品列表各最多读取 10 页、每页请求 200 条；每个执行的任务请求最多 200 条，没有继续翻页。
- 缺陷按前 20 个未删除产品读取，每产品最多 4 页（代码按每页 20 条判断），再本地筛选指派人。产品多、缺陷多或权限不足时可能不完整；「全部」仅指本次已拉取的数据，不是服务端全部历史。
- 单个执行/产品读取失败可能被跳过；任务、缺陷只有一侧成功时仍可展示另一侧。全部刷新失败时保留内存中的旧列表，应结合刷新时间和错误提示判断，重启后没有持久化离线列表。
- 首页、分类数量和悬浮预览仍只使用个人待办列表；展开的其他负责人子任务仅作参考，不加入数量或排序。点击列表展开的子任务或详情中的子任务，均在挂件内打开详情；详情底部仍可打开禅道网页。他人或无法确认负责人的任务在挂件内只读，无开始/完成/关闭按钮；主进程在每次写入前重新读取并核对当前负责人，读取失败或不再指派给自己时拒绝写入，网页操作仍由禅道自身权限控制。
- 子任务使用任务详情响应中的 `children`（数组或 ID 索引对象），不额外扫描全站或假设部署支持其他全局接口。未提供/null/无法识别的子任务数据会明确提示无法确认，不当作 0 条；只展示可识别条目时会提示数据不完整。明确空数组/空对象只表示本次接口返回 0 条，不保证不存在权限外或接口省略的数据。缺少父任务标记的列表条目也可按需点展开查询，不在刷新时为每条任务自动拉详情。
- 禅道版本、插件和部署方式可能改变接口响应。主客户端接受 Token 创建返回 200 或 201，并在 401/登录 HTML 后重登一次，但这不代表兼容所有禅道版本或 SSO 登录方式。
- 任务/缺陷操作后会回查状态；如果回查失败，代码会跳过该校验，返回成功不能单独作为服务端修改已确认的证据，必要时在禅道网页核对。

## 安全与隐私

- **密码以明文保存在应用的 `config.json` 中，未使用系统钥匙串或加密存储**；配置（含密码）也会通过 preload 提供给本地渲染界面。请限制电脑和该目录的访问，不要共享配置、完整用户数据、日志或含敏感任务的截图。
- REST Token 由客户端缓存在内存中，不写入应用配置；挂件不复用系统浏览器的登录 Cookie，浏览器已登录不等于挂件已完成认证。
- 尽量使用 HTTPS 和受信任的禅道服务。HTTP 会明文传输登录凭据及业务数据；VPN/内网可达不等于传输已加密。
- 禅道描述/评论是外部富文本。当前只有正则清洗和 CSP 等防护，不应视为经过完整安全审计的 HTML 消毒器；图片策略允许 HTTP/HTTPS 远程图片，可能产生外部请求。
- 点击附件会重新验证所属任务/缺陷、用 Token 下载到系统临时目录，再由系统默认程序打开。**不要打开不可信附件**。打开成功后的临时文件不会由当前代码主动删除，可能保留敏感内容；失败时才清理该次临时目录。
- 主面板启用了 `contextIsolation`、关闭 Node 集成，但其 `sandbox` 为 `false`；悬浮球及预览窗口使用沙箱。这些设置不是安全保证。
- 应用自动更新会执行替换文件的 Windows PowerShell 助手。默认只在已打包应用中启动后约 8 秒及之后每 5 分钟自动检查，需用户点击安装；可在设置中关闭自动检查。应用小包检查 SHA-256，完整包校验依赖 Release 是否提供摘要，不应将其描述为已签名更新。
- 真实本地配置和探测结果已列入 `.gitignore`；忽略规则不能阻止手动强制添加，也不能撤销已提交的秘密。提交前仍应检查差异。

## 开发命令

| 命令 | 实际作用 |
| --- | --- |
| `npm start` | 启动 Electron 应用；已有真实配置时会连接禅道 |
| `npm run pack` | 构建 Windows x64 目录、完整 zip、应用小包和更新元数据；会清空旧 `release/` |
| `npm run icon` | 重新生成 `assets/icon.png` / `assets/icon.ico` |
| `npm run probe` | 读取根目录本地配置，访问真实禅道接口并写 `probe-result.json` |
| `npm run release` | 从 CHANGELOG 当前版本章节读取更新内容，默认先打包；有 `GITHUB_TOKEN` 时创建正式 Release、上传三项产物并通知 |
| `npm run ship -- --note "说明"` | 默认升 patch 版本、`git add -A`、提交、推送，再打包发布；不是本地验证命令 |

**发布命令会改变远端状态，不用于日常检查。** `ship --no-push` 只跳过 Git 推送，不禁止后续 Release 发布；没有令牌也仍可能提交、推送和打包。`ship --dry` 才只打印计划。不要在含其他未提交工作的目录里盲目执行。

### 打包与发布

`npm run pack` 可在 Windows/Linux/macOS 构建机执行，但**目标始终是 Windows x64**：优先复用本机 Windows Electron，再用缓存，最后尝试 `ELECTRON_MIRROR`、npmmirror 和 GitHub 下载源。目标运行时下载源应可信。产物为：

```text
release/
├── ZentaoWidget-win32-x64/        # 完整运行目录
│   └── ZentaoWidget.exe
├── ZentaoWidget-win32-x64.zip     # 首次安装/完整更新
├── ZentaoWidget-app.zip           # 匹配运行时的应用更新
└── ZentaoWidget-update.json       # 版本、运行时及应用包摘要
```

更新器只有在版本、Electron、平台和架构等元数据匹配时才选择应用小包，否则回退完整包；Windows 更新助手有等待超时和失败回滚处理，但仍应先备份重要配置。程序目录必须可写，替换失败时查看用户数据下 `updates/` 内的日志。

`.github/workflows/release.yml` 在 `main` 推送或手动运行时进入流程，其中仅手动触发或 `release:` 开头的提交执行发布 job；使用 Windows 和 Node.js 22，测试后打包、发布。普通 PR 没有配置自动验证流水线。`WECOM_WEBHOOK_URL` 是可选发布通知 Secret，只在确认正式 Release 已公开后发送通知；不要将令牌或 webhook 写进源码。

发布说明默认读取 `CHANGELOG.md` 中与 `package.json` 版本一致的章节，保留小标题和更新条目；找不到或内容为空时停止发布。`--note "说明"` 可显式覆盖。使用 `ship` 升版本时，应先准备升后版本对应的 CHANGELOG 章节；CI 和本地发布使用同一提取逻辑。

企微消息包含版本、该版本的更新内容及下载链接。长正文按 UTF-8 字节限制保留摘要并标注完整说明链接；不会为了长正文拆成多次通知。缺少正文时不会发送空摘要消息。

需要补全已发布版本说明并补发通知时，在 Actions 手动运行「补全发布说明并补发企微通知」，填写例如 `v0.3.13`。该入口先从 CHANGELOG 更新已有正式 Release 的说明，再发送一次企微消息，不重新打包、创建版本或修改附件。它需要现有 `GITHUB_TOKEN` 和 `WECOM_WEBHOOK_URL`；失败后先核对实际状态，不盲目重跑。对应本地命令 `node scripts/notify-release.mjs v0.3.13` 也会修改远端说明并发消息，不能用作检查命令。

### 检查与测试

仓库没有 `npm test`、lint 或 typecheck 脚本。现有测试使用 Node 内置测试器，CI 的完整命令为：

```sh
node -e "require('electron')"
node --test test/attachments.test.cjs test/task-actions.test.cjs test/task-action-dialog.test.cjs test/task-children.test.cjs test/updater.test.cjs test/update-check.test.cjs test/window.test.cjs test/release-notify.test.mjs test/release-publish.test.mjs
```

附件测试包含真实 Electron 界面测试，需要可运行的图形环境；窗口和部分 PowerShell 更新测试仅在 Windows 执行，其他平台会跳过。测试使用本地 HTTP fixtures、替身和临时目录，不需要真实禅道账号或真实发布令牌；跳过不等于对应平台行为已验证。

不安装依赖、不启动应用时，可先执行语法检查，例如 `node --check electron/main.js`。独立的发布通知/发布异常测试使用模拟请求，可运行：

```sh
node --test test/release-notify.test.mjs test/release-publish.test.mjs
```

子任务显示、主进程操作保护和 renderer 交互的无账号/无真实网络回归可独立运行（使用明确客户端、网络和窗口替身，不依赖 Electron 运行时）：

```sh
node --test test/task-children.test.cjs
```

该用例执行真实主进程 IPC handler 和 renderer 函数，但不替代 Windows/Electron 图形环境中的布局与交互验收。

关闭任务确认框的尺寸与取消/确认边界另有无账号回归：`node --test test/task-action-dialog.test.cjs`。`test/window.test.cjs` 包含使用真实 Electron 窗口、preload 和悬浮球的确认框回归；该原生窗口用例仅在 Windows 自动执行，不能以无图形环境的逻辑测试代替 Windows 验收。

`npm run probe` 不是测试套件：它会访问真实服务器，输出地址、账号和任务数据；而且目前仅将 Token 认证 HTTP 200 视为成功，正常的 201 响应也可能误报，不能据此认定挂件登录失败。首次运行无配置时会从模板生成本地文件后退出，填写真实信息前请先确认授权。

`--mock` 也**不是完整网络隔离**，部分任务操作、附件、配置测试和更新路径仍可能访问真实服务；不要把它当作阻止真实写入的安全开关。

## 代码与贡献

主要目录和开发约束见 [AGENTS.md](AGENTS.md)，历史变更见 [CHANGELOG.md](CHANGELOG.md)。修改行为时请同步相关文档、添加对应测试，并明确记录已执行、失败、跳过和未执行的验证。

仓库当前没有 LICENSE 文件；不要自行假设或补写一个未经维护者确认的开源许可证。
