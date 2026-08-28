# Claude Workspace

> 面向 Windows 的本地多工程 Claude Code 桌面工作台

[快速开始](#快速开始) · [企业微信远程回复](#企业微信远程回复) · [常见问题](#常见问题)

Claude Workspace 帮你在一个桌面窗口中组织多个工程和 Claude Code 会话。每个工程会话都以对应项目目录作为工作目录，完整保留 Claude Code 原生终端交互；不需要项目上下文时，也可以随时创建隔离的临时会话。

它适合同时维护多个代码库、希望减少终端窗口切换，或需要在离开电脑后通过企业微信处理 Claude Code 权限确认和问题回复的开发者。

> [!IMPORTANT]
> Claude Workspace 不包含、代理或重新实现 Claude Code。它会启动你电脑上已经安装并登录的 Claude Code CLI。文件和命令在本机执行，但模型请求仍由 Claude Code 发往你配置的 Anthropic、Amazon Bedrock、Google Vertex AI、Microsoft Foundry 或企业网关；这不是离线模型客户端。

## 功能亮点

| 能力 | 说明 |
| --- | --- |
| 多工程工作区 | 添加多个本地项目，以真实工程目录作为 Claude Code 的 `cwd` |
| 多会话管理 | 在一个窗口内创建、切换、停止、重启、重命名和删除会话 |
| 原生终端体验 | 保留 Claude Code TUI、权限确认、斜杠命令、ANSI 输出和键盘交互 |
| 临时会话 | 无需选择工程，自动创建相互隔离的临时工作目录 |
| 快速切换 | 使用 `Ctrl+K` 按工程名、别名、路径或会话名搜索 |
| 状态提醒 | 后台会话产生新输出时显示未读标记，结束或失败时发送系统通知 |
| 修改文件查看 | 在右侧栏查看 Git 修改列表、相对 `HEAD` 的对比和磁盘最新内容；代码支持语法高亮，Markdown 支持 GFM 与 Mermaid |
| 工作区整理 | 支持工程别名、置顶和折叠，会话标签与界面状态可跨应用重启保留 |
| 企业微信协作 | Claude Code 等待授权、提问、计划确认或完成回复时，可推送消息并接收远程输入 |
| 本地优先 | 项目文件不经过 Claude Workspace 云服务，企业微信 Secret 使用系统安全存储保护 |

## 快速开始

### 运行要求

- Windows 10 或 Windows 11，x64 架构。
- 已按照 [Claude Code 官方文档](https://code.claude.com/docs/en/setup) 安装并登录 Claude Code。
- 能够访问 Claude Code 所使用的模型服务或企业网关。
- Git（“修改文件”侧栏需要；不使用该功能时可选）。
- Node.js 仅在从源码开发或构建时需要，使用安装包无需安装 Node.js。

先在普通 PowerShell 中确认 Claude Code 可以独立运行：

```powershell
where.exe claude
claude --version
claude
```

### 安装

1. 找到与本文档放在同一目录中的 `Claude Workspace-<版本号>-x64.zip`。
2. 将 ZIP 完整解压到一个独立目录，不要直接在压缩包内运行程序。
3. 双击解压目录中的 `Claude Workspace.exe` 启动应用。

> [!NOTE]
> 当前程序未配置商业 Authenticode 代码签名证书，Windows SmartScreen 可能显示未知发布者提示。请确认压缩包来自可信的分发渠道。

### 第一次使用

1. 启动 Claude Workspace。左侧的 Claude Code 状态卡会自动查找本机 CLI。
2. 点击“选择工程文件夹”，添加实际项目根目录。
3. 在工程下点击“新建会话”，Claude Code 会在该目录中启动，并读取其中的 `CLAUDE.md`、`.claude/`、Git 和项目配置。
4. 不需要项目上下文时，点击“新建临时会话”。每个临时会话都有独立的应用管理目录。
5. 使用左侧列表切换会话，或按 `Ctrl+K` 快速搜索工程和会话。
6. 在工程会话工具栏点击“修改文件”，选择文件后切换“对比”或“最新内容”。Markdown 最新内容默认渲染预览，其中的 `mermaid` 代码块会显示为图表，也可切换回源码。

Claude Workspace 会自动查找原生安装的 `claude.exe` 和 npm 安装产生的 `claude.cmd`。如果自动检测失败，可以点击“选择文件”，手动指定 `.exe`、`.cmd`、`.bat` 或 `.ps1` 启动文件。

## 常用操作

| 操作 | 使用方式 |
| --- | --- |
| 新建工程会话 | 在工程列表下点击“新建会话” |
| 新建临时会话 | 点击侧栏顶部的 `›_`，或临时会话分组中的按钮 |
| 快速搜索和切换 | 按 `Ctrl+K`，输入工程名、别名、路径或会话名 |
| 修改工程别名 | 双击工程名称，或点击铅笔按钮 |
| 置顶工程 | 点击工程右侧的星标 |
| 重命名会话 | 双击会话名称，或点击铅笔按钮 |
| 复制终端文本 | 选中文本后按 `Ctrl+C` / `Ctrl+Shift+C`，或右键 |
| 粘贴到终端 | 按 `Ctrl+V` 或 `Ctrl+Shift+V` |
| 中断终端命令 | 未选中文本时按 `Ctrl+C` |
| 恢复对话 | 重启会话后，在 Claude Code 中使用 `/resume` |
| 查看修改文件 | 在工程会话工具栏点击“修改文件”；列表每 4 秒自动刷新，也可手动刷新 |

从列表移除工程只会删除 Claude Workspace 中的记录，不会删除磁盘上的项目文件。删除临时会话会同时删除它的临时工作目录及其中的文件，应用会在执行前要求确认。

## 企业微信远程回复

Claude Workspace 可以通过企业微信智能机器人的 WebSocket 长连接，在 Claude Code 真正等待输入时发送通知，并把你的回复精确写回对应的本地会话。该功能不需要暴露公网回调地址。

### 准备工作

1. 在企业微信管理后台创建智能机器人，选择“API 模式”和“使用长连接”。
2. 确认接收用户在机器人的可见范围内，并准备好 Bot ID、Secret 和接收人的企业微信 `userid`。
3. 在 Claude Workspace 左侧打开“企业微信远程回复”；启用选项默认已勾选，填写配置后保存。
4. 等待状态变为“已连接”，然后新建或重启需要远程回复的 Claude Code 会话。

客户端通过 Claude Code 的 `PermissionRequest`、`PreToolUse`、`Stop` 和 `Notification` Hooks 判断何时需要提醒，可覆盖权限确认、`AskUserQuestion`、计划确认、等待输入和本轮回复完成等场景。

### 如何回复

每条待回复消息都有一个独立的 8 位回复码，并绑定到具体客户端会话和本次 Claude Code 进程。

- 引用机器人通知回复时，只需发送选项编号或文字，例如 `1`、`允许`、`继续运行测试`。
- 不引用通知时，需要带上回复码，例如 `AB3KD7Q2 1`。
- 多个问题用分号或换行分隔，多选项用逗号分隔，例如 `AB3KD7Q2 1;2,3`。
- 菜单类问题可以回复编号或通知中显示的完整选项文字；存在歧义时，客户端会要求改用编号。

回复码是远程输入的授权凭证。请勿转发带回复码的通知；进程退出、会话重启或本地用户继续输入后，旧的待回复路由会失效。

> [!WARNING]
> 同一组 Bot ID 和 Secret 同时只能维持一个有效长连接。多台电脑或多个用户同时运行时，每个客户端都应配置独立机器人，否则新连接会断开旧连接。当前每个客户端只配置一个主动通知接收用户。

企业微信功能基于企业微信团队维护的 [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk)，并使用 [Claude Code Hooks](https://code.claude.com/docs/en/hooks) 接收本机事件。

## 数据与安全

- Claude Workspace 直接在所选目录中启动本机 Claude Code，不提供中转模型请求的云服务。
- 工程列表、会话标签、Claude Code 路径和应用配置保存在 Electron 用户数据目录，Windows 默认位置为 `%APPDATA%\Claude Workspace\workspace.json`。
- 终端输出只保留在当前应用进程的内存缓冲区，不写入 `workspace.json`。Claude Code 自身保存的历史可以通过 `/resume` 恢复。
- 临时工作目录位于 `%APPDATA%\Claude Workspace\temporary-workspaces`，只有删除对应临时会话时才会被清理。
- 企业微信 Secret 通过 Electron `safeStorage` 使用操作系统凭据保护能力加密后保存，不会以明文传给界面层。
- Claude Code Hook 服务只监听 `127.0.0.1` 的随机端口，并要求每次应用启动时生成的 Bearer Token。
- 界面运行在启用沙箱和上下文隔离的 Renderer 中，只能通过受限 IPC 调用主进程能力，不能任意启动进程。
- 界面不能直接读取磁盘或执行 Git。“修改文件”只能通过已保存的工程 ID 请求主进程，并且只能读取当前 Git 修改列表中的工程内相对路径；目录穿越、控制字符路径和伪造的未修改文件路径会被拒绝，符号链接也不会被跟随读取其目标内容。
- 文件最新内容限制为 2 MB，单个 Git 对比输出限制为 3 MB；二进制文件不会作为文本解码。Markdown 原始 HTML 不会渲染，Mermaid 使用严格安全模式，单个图表代码块限制为 100,000 个字符。
- 远程回复必须匹配仍然有效的回复码和 Claude Code 进程实例；过期回复不会写入其他终端。

远程通知可能包含工作目录、工具名称与参数、问题选项、计划正文或 Claude Code 的实际回复，以便你判断如何处理。结构化参数中名称类似 `token`、`secret`、`password` 的值会被隐藏，但自然语言或命令中的凭据无法可靠自动识别。请限制机器人的可见范围，不要在提示词或命令中直接写入敏感信息。

## 当前限制

- 当前只提供 Windows x64 构建，尚未提供 Windows ARM64、macOS 或 Linux 发行版。
- 关闭客户端会终止所有正在运行的本地 PTY 进程，企业微信长连接也会停止。
- 会话标签会持久化，但终端输出不会跨应用重启保留；需要依赖 Claude Code 的 `/resume` 恢复对话。
- 多个会话可以指向同一个工程目录，因此也可能同时修改同一批文件；当前不会自动创建 Git worktree。
- 修改文件侧栏依赖本机 `git`，只展示 Git 工作区状态；非 Git 工程、超过 2 MB 的文本文件和二进制文件不提供内容预览。
- 企业微信远程回复依赖支持 HTTP Hooks 的 Claude Code 版本。如果组织策略限制 `allowedHttpHookUrls`，管理员需要允许客户端生成的本机 `127.0.0.1` Hook 地址。
- 当前构建未配置商业代码签名证书。

## 常见问题

### 自动检测到的 `Claude.exe` 无法启动

如果 `where.exe claude` 的第一项是：

```text
%LOCALAPPDATA%\Microsoft\WindowsApps\Claude.exe
```

它通常是 Claude Desktop 注册的 Windows 应用别名，不是 Claude Code CLI。Claude Workspace 会忽略该路径，并优先查找：

```text
%USERPROFILE%\.local\bin\claude.exe
```

也可以点击“选择文件”，手动选择上述原生 CLI 或 npm 安装目录中的 `claude.cmd`。

### 出现 `Cannot create process, error code: 193`

这表示选择的文件不是可运行的 Windows Claude Code CLI。请勿选择 Claude Desktop、WindowsApps 应用别名或 WSL/Linux 中的 `claude` 文件；重新自动检测，或手动选择 Windows 原生 `claude.exe` / `claude.cmd`。

### 企业微信显示“连接被其他客户端占用”

关闭其他使用同一组 Bot ID/Secret 的客户端，或为当前客户端创建独立机器人。同一组凭据不能同时服务多个长连接客户端。

### 企业微信已发送回复，但本地终端没有输入

先查看左侧企业微信状态卡中的最近入站记录，再确认：

- 机器人状态为“已连接”。
- 回复引用了正确通知，或消息中包含正确的 8 位回复码。
- 对应 Claude Code 会话没有退出、重启，也没有在本地继续输入。
- 消息来自机器人单聊；群聊消息会按安全策略忽略。

### 完全断网时能否使用？

可以打开客户端和管理本地工作区，但 Claude Code 仍需要连接已配置的模型服务才能生成回复。“本地”指文件、命令和进程在本机执行，不代表模型离线运行。

## 问题反馈

如有问题或建议，请联系 `tianxiabai`。

## 免责声明

Claude Workspace 是独立开发的第三方工具，不是 Anthropic 官方产品，也不代表 Anthropic 对本项目的认可或背书。Claude、Claude Code 及相关名称和商标归其各自权利人所有。
