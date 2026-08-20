# Claude Workspace

面向 Windows 的本地多工程 Claude Code 控制台。客户端不重新实现 Claude Code，而是在已选择的工程目录或应用管理的临时工作目录中启动本机 `claude`，并通过嵌入式终端原样呈现其 TUI。

## 当前功能

- 使用 Windows 原生文件夹选择框添加工程。
- 将选择的绝对目录作为 Claude Code 进程的 `cwd`。
- 持久化工程列表和自定义 Claude Code 路径。
- 一个窗口中创建、切换和停止多个 Claude Code 会话。
- 已退出、启动失败或意外中断的会话可在原工作目录中重启，并复用原会话标签和当前终端视图。
- 支持不选择、不关联工程目录的临时会话；每个会话使用独立的应用隔离目录。
- 会话支持重命名和从列表删除；默认名称包含序号与创建时间。
- 会话标签会跨应用重启保留；意外关闭前仍在运行的会话会显示为“已中断”。
- 工程会话列表支持独立折叠/展开，并保存折叠状态。
- 左侧工程文件夹名称使用加粗显示，切换多个工程时更容易区分。
- 工程支持自定义别名和置顶，同名目录也能快速区分。
- 使用 `Ctrl+K` 按工程名、路径或会话名快速搜索和切换。
- 非当前会话有新输出时显示未读标记，会话完成或失败时发送系统通知。
- 可连接企业微信“智能机器人”的 API 长连接模式；Claude Code 请求权限、提出问题、等待计划确认或完成本轮回复时，主动推送具体内容到指定企业微信用户并接收远程回复。
- 每条企业微信待回复消息使用独立回复码，并同时绑定企业微信 userid、客户端会话和本次 Claude Code 进程；多个进程并发等待时不会按“最近消息”模糊路由。
- 保留 Claude Code 原生输入、权限确认、斜杠命令和终端输出。
- 通过系统剪贴板支持终端复制粘贴，不依赖网页剪贴板权限。
- 自动查找原生安装的 `claude.exe` 和 npm 安装产生的 `claude.cmd`。
- 支持手动选择 `.exe`、`.cmd`、`.bat` 或 `.ps1` 启动文件。
- 关闭程序时，如果仍有运行中的会话，会先进行确认。

## 运行要求

- Windows 10/11 x64。
- Node.js 22.12 或更高版本（仅开发和构建需要）。
- 本机已经安装并登录 Claude Code。
- 能够访问所配置的 Anthropic、Bedrock、Vertex、Foundry 或企业网关端点。
- 使用企业微信远程回复时，需要一个以“API 模式、使用长连接”创建的企业微信智能机器人，并取得 Bot ID、Secret 和接收人的企业微信 userid。

先在普通 PowerShell 中确认 Claude Code 可用：

```powershell
where.exe claude
claude --version
claude
```

如果 `where.exe claude` 的第一项是
`%LOCALAPPDATA%\Microsoft\WindowsApps\Claude.exe`，该文件是 Claude Desktop
注册的应用别名，不是 Claude Code CLI。客户端会忽略这个路径，并优先使用：

```text
%USERPROFILE%\.local\bin\claude.exe
```

遇到 `Cannot create process, error code: 193` 时，请点击“自动检测”，或通过
“选择文件”指定上述原生 CLI。不要选择 Claude Desktop、WindowsApps 别名或
WSL/Linux 中的 `claude` 文件。

“本地 Claude Code”表示文件、命令和进程在本机执行，不表示模型离线运行。完全断网时无法获得模型响应。

## 本地开发

```powershell
npm ci
npm run dev
```

只预览界面和交互、不启动真实 Claude Code 时，可以运行
`npm run dev:renderer`，然后访问 `http://127.0.0.1:5173/?preview=1`。

生产构建和验证：

```powershell
npm test
npm run typecheck
npm run build
```

## 生成 Windows 安装程序

建议直接在 Windows x64 或仓库自带的 GitHub Actions 工作流中构建：

```powershell
npm ci
npm run dist:win
```

不生成安装器、只检查 Windows x64 应用目录时可以运行：

```powershell
npm run pack:win
```

在非 Windows 构建机上需要直接交付时，可以生成免安装 ZIP：

```powershell
npm run dist:win:zip
```

ZIP 输出到 `release/Claude Workspace-<版本号>-x64.zip`。解压后直接运行其中的 `Claude Workspace.exe`。

安装文件输出到：

```text
release/Claude Workspace-Setup-<版本号>-x64.exe
```

当前工程没有配置商业代码签名证书，因此本地生成的安装程序可能触发 Windows SmartScreen 提示。正式分发前应加入 Authenticode 签名。

## 使用方式

1. 已有项目任务时，点击“选择工程文件夹”，选择实际项目根目录，例如 `D:\workspace\mall-service`。
2. 不需要项目上下文时，直接点击“新建临时会话”，无需选择目录。
3. 如果没有自动找到 Claude Code，点击“选择文件”，选择本机 `claude.exe` 或 `claude.cmd`。
4. 工程会话会读取对应目录的 `CLAUDE.md`、`.claude/`、Git 和源码配置；临时会话则在独立的应用隔离目录中运行。
5. 会话退出、启动失败或因客户端关闭而中断后，点击右上角“重启会话”可在同一工作目录重新启动 Claude Code；如需恢复原对话，请在 Claude Code 中使用 `/resume`。
6. 双击会话名称或点击铅笔按钮可以重命名。删除工程会话不会删除工程文件；删除临时会话会同时清理其临时工作目录和其中的文件。
7. 点击工程或“临时会话”左侧箭头可以折叠、展开会话列表。
8. 双击工程名称可以设置别名，点击星标可以置顶工程。
9. 按 `Ctrl+K` 可以搜索工程、目录和会话并直接切换。

## 企业微信远程回复

本功能使用企业微信团队维护的
[`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk) 建立
WebSocket 长连接，不需要暴露公网回调地址。Claude Code 侧使用官方
[`PermissionRequest`、`PreToolUse`、`Stop` 和 `Notification` Hooks](https://code.claude.com/docs/en/hooks)
识别真正需要用户输入的时刻，不依赖终端文本关键字猜测。

配置步骤：

1. 在企业微信管理后台创建“智能机器人”，选择“API 模式”和“使用长连接”，并确保目标用户在机器人的可见范围内。
2. 在左侧“企业微信远程回复”中点击“开始配置”，填写 Bot ID、Secret 和接收用户 userid 后启用。
3. 状态显示“已连接”后，新启动的 Claude Code 会话会自动加载当前客户端专用的 Hooks。
4. 收到通知后，可以直接引用该消息并只发送回复内容；不引用时按消息给出的格式回复，例如 `AB3KD 1` 或 `AB3KD 继续处理并运行测试`。多个问题之间使用分号，多选项使用逗号，例如 `AB3KD 1;2,3`。

同一组 Bot ID/Secret 同时只能保持一个有效长连接。另一台电脑、另一个 Windows 用户或旧客户端如果使用相同凭据建立连接，企业微信会断开原连接；客户端会明确显示“连接被其他客户端占用”。因此，无中心服务的多人部署必须为每个同时运行的客户端配置独立机器人，不能把同一组 Bot ID/Secret 内置后分发给所有人。

不引用机器人通知时，回复码是强制的。即使当时看起来只有一个待回复会话，客户端也不会把无回复码消息自动发给“最近的”进程，因为用户阅读消息和发送回复之间可能又出现新的并发请求。引用一条包含回复码的机器人通知时，客户端从引用内容提取回复码，因此只需发送回复内容。

当前每个客户端配置一个接收用户 userid，并只接受该用户在机器人单聊中发来的回复；群聊消息和其他用户消息不会写入终端。客户端退出后长连接与本地 Claude Code 进程都会结束，因此远程回复功能也会停止。

左侧企业微信状态卡会显示最近一条入站回复的处理结果，包括已路由、回复码无效、userid 不匹配或消息被忽略。若企业微信里发出回复后这里始终没有入站记录，说明回复没有到达当前客户端，应优先检查机器人长连接是否被其他客户端占用。

终端剪贴板快捷键：

- 鼠标选中文本后按 `Ctrl+C` 或 `Ctrl+Shift+C` 复制；也可以右键复制选区。
- 按 `Ctrl+V` 或 `Ctrl+Shift+V` 粘贴。
- 没有选中文本时，`Ctrl+C` 仍然发送终端中断信号。

工程和会话配置保存在 Electron 的用户数据目录中；从客户端移除工程只会删除列表记录，不会删除磁盘上的工程文件。临时工作目录也位于用户数据目录中，会一直保留到用户明确删除对应临时会话。

## 安全边界

- Renderer 不接收任意进程启动权限，只能通过已保存的工程 ID 或受限的“临时会话”范围创建会话。
- 工程路径由主进程的原生目录选择器获取并进行 `realpath` 校验。
- 临时目录只由主进程在应用用户数据目录下生成；清理操作会校验路径边界，不能删除该范围外的目录。
- Claude Code 可执行文件必须是用户明确选择或在受信安装位置发现的真实文件。
- 原生 `.exe` 直接启动；Windows 脚本包装器通过固定 PowerShell 调用，并通过环境变量传参，避免拼接用户路径。
- Electron 启用了 `contextIsolation`、沙箱化 preload、禁用 renderer Node.js，并限制页面导航。
- 企业微信 Secret 通过 Electron `safeStorage` 使用操作系统凭据保护能力加密后再落盘，不会以明文写入 `workspace.json` 或传给 Renderer。
- Claude Code Hook 只连接 `127.0.0.1` 的随机端口，并使用每次应用启动生成的 Bearer Token；回调还必须匹配当前 PTY 的启动实例。
- 企业微信回复必须同时匹配已配置的 userid 和唯一回复码；过期码、已退出/重启进程的码不会写入任何终端。
- 为便于远程判断，通知会包含工作目录、待确认工具及参数、问题选项、计划正文或 Claude Code 本轮的实际回复；结构化参数中名称类似 token、secret、password 的值会隐藏。请限制机器人的可见范围，并避免把凭据直接写入命令或自然语言文本。

## 当前限制

- 工程和会话标签会持久化，但终端输出不会写入配置文件；Claude Code 自身的历史可在新会话中通过 `/resume` 找回。
- 关闭客户端会终止当前 PTY 进程。
- 多个会话如果指向同一个普通工作目录，仍可能修改相同文件；第一版尚未自动创建 Git worktree。
- 第一版仅配置 Windows x64 安装目标，尚未配置 Windows ARM64。
- 未内置 IntelliJ IDEA 控制接口；IDEA 与客户端可以同时打开同一工程。
- 企业微信集成依赖支持 HTTP Hooks 的较新 Claude Code 版本；如果企业策略通过 `allowedHttpHookUrls` 禁止本机 Hook 地址，通知不会触发，需要由管理员按组织策略放行客户端生成的 `127.0.0.1` 回调地址。

## 目录结构

```text
src/
├── main/       Electron 主进程、工程存储、Claude 路径发现和 PTY 会话
├── preload/    受限 IPC 桥接
├── renderer/   React UI 与 xterm.js 终端
└── shared/     主进程与 Renderer 共用的契约
tests/          路径、持久化、Windows 启动方式和会话管理测试
```
