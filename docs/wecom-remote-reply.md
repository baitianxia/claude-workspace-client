# 企业微信远程回复 Claude Code 提示：技术设计

状态：当前规范。本文是“Claude Code 终端控制机器人”把企业微信回复送回终端提示（权限确认、AskUserQuestion、ExitPlanMode）这条链路的技术所有者文档。实现变更如果影响这里定义的行为，必须在同一变更中更新本文。

## 问题

Hook 到达时并不知道 Claude Code 会画出什么菜单。源码（Claude Code CLI，随 SDK 0.3.251 附带的二进制）表明菜单形状由多个运行时条件决定，而 Hook payload 里一个都没有：

| 提示 | 终端编号行 | 决定条件 |
| --- | --- | --- |
| AskUserQuestion 单选、无 preview | n + 2 | `n+1.` 输入行（placeholder `Type something.`），`n+2. Chat about this` |
| AskUserQuestion 多选 | n + 1 | `Chat about this` 只在 `!multiSelect` 时构造 |
| AskUserQuestion 单选、任一选项带 `preview` | n + 1 | 走另一个组件，`Chat about this` 存在但**不带编号**，方向键可达 |
| 屏幕阅读器模式 | 不定 | `isScreenReaderEnabled` 上下文为 true 时 `Chat about this` 进入列表且无编号 |
| PermissionRequest | 2 … 5+ | `yes` / `yes-dont-ask-again` / `yes-session` / `yes-prefix`+`yes-exact` / `yes-enable-auto-mode` / `yes-accept-edits-keep-context` / `no`，其中“启用自动模式”等行与 `permission_suggestions` 无关 |

再叠加用户机器上 Claude Code 版本差异。因此：**菜单形状只在屏幕上可靠，且只在用户回复那一刻可靠；通知阶段的任何推断都是猜测。**

## 分层

```
企业微信回复
   │
   ├─ A 层  prompt 被挂起（owner 离开 + 连接正常 + 设置开启）
   │        → 回复翻译成 Hook 响应，Claude Code 直接应用，终端不画对话框
   │
   └─ B 层  对话框已在终端上
            → 回复按当下屏幕菜单晚绑定 → 移光标 → 读屏确认 → Enter
                 ▲
                 └─ C 层  屏幕来源：主进程 headless xterm 镜像（有）/ renderer 上报（无）
```

### A 层：Hook 直达决定（`claude-hook-server.ts`、`remote-hook-decision.ts`、`wecom-bridge.ts`）

- `PermissionRequest` 与 `PreToolUse`（AskUserQuestion、ExitPlanMode）是“决定型 Hook”：`ClaudeHookServer` 为它们的事件附带 `decision` 句柄。监听器在事件派发期间**同步**调用 `hold()` 即可把 HTTP 请求挂起；否则服务器立刻回 `{}`，Claude Code 照常弹对话框。这两类 Hook 的 `timeout` 配置为 3600 秒；客户端崩溃会直接断开连接，Claude Code 立刻继续。
- `WeComBridge.shouldHoldPrompt`：仅当 `decision` 可用且未结算、设置 `holdPromptsWhileAway` 未关闭、提示是 `menu` 型的 permission/question/plan、企业微信长连接已认证、且 `isOwnerAway()`（系统空闲）为真时挂起。挂起的提示按回复码登记在 `heldPrompts`，同一提示的两条 Hook（AskUserQuestion 会先后触发 PreToolUse 和 PermissionRequest）共用一个回复码并一起作答。
- 回复翻译（`resolveHeldReply`）：
  - 权限：首项 → `{behavior:"allow"}`；末项 → 进入 `permission-denial-reason` 阶段，收到原因后 `{behavior:"deny", message}`；中间行 → `allow` + `updatedPermissions`（payload 中 `addRules`/`addDirectories` 且非 deny/ask 的建议）。
  - 问题：选项 → `permissionDecision:"allow"` + `updatedInput:{…tool_input, answers:{[question]: label}}`，多选用 `", "` 连接；「其他：内容」→ 内容作为答案；「讨论：内容」→ `deny` + reason（等价于放弃选项、把话转给 Claude）；多问题向导逐题解析，无法匹配选项的回答作为自由文本提交（Hook 协议允许，终端向导不允许）。
  - 计划：`1`/批准 → allow；`2`/拒绝 → `plan-feedback` 阶段；「拒绝：意见」一步完成 deny + reason。
  - 输出形状：`PermissionRequest` 用 `hookSpecificOutput.decision`，`PreToolUse` 用 `permissionDecision` / `permissionDecisionReason` / `updatedInput`。
- 交还终端时清除该回复码上已进入的分阶段选择（例如已选“拒绝”、等待原因），并向接收人推送一条提示，要求重新选择；否则下一条消息会被当作原因文本直接写进终端。
- 交还终端：本地键盘输入该会话、会话退出、重新配置、企业微信连接断开/出错/被占用（没有连接就没人能回答）、owner 回到电脑旁（每 3 秒轮询一次 `isOwnerAway`）、或界面点击“在本机处理”（IPC `releaseHeldPrompts`）都会 `release()`，Claude Code 随即弹出对话框。回复码保留，后续回复走 B 层。Claude Code 自己放弃等待（连接关闭）时同样转入 B 层。
- 界面：`WeComState.heldPrompts` 驱动会话上方的横幅；`WeComState.holdPromptsWhileAway` 对应设置中的开关，默认开启。

### B 层：按键晚绑定与两阶段提交（`remote-menu-binding.ts`、`wecom-bridge.ts`）

回复到达后才读取屏幕（`parseVisibleMenu`），并把通知中的选择绑定到屏幕上的行：

- 权限：首行必须像允许（`Yes/Allow/是/允许/同意`）、末行必须像拒绝（`No/Deny/否/拒绝`），否则不是权限对话框。通知的第 1 项 → 屏幕首行，通知末项 → 屏幕末行，两者在任何布局下都成立；中间行只在两边项数一致（且来自屏幕的通知文字一致）时直接执行，否则返回 `confirm`。
- 身份校验：`identityProbes`（命令首行全文、URL host、文件名、建议规则/目录名）至少一个要出现在屏幕上，否则视为排队中的另一条请求，返回 `confirm`。探针必须以整词出现在某一行或连续几行（换行处按空格和直接拼接两种方式复原）中，`npm test --foo` 不能匹配 `npm test --foobar`，共享长前缀的两条命令也不互相匹配；不再有任何无边界的前缀匹配，对话框把超长命令缩略显示时校验失败，回复需经「确认 N」。
- 问题：通知里 Claude 的每个选项都必须出现在屏幕上（身份）；选择按标签匹配；`Type something` / `Chat about this` 按别名识别；`Chat about this` 不可见时返回 `probe`，由执行层向下探一行并核对标签。
- 计划及其他菜单：按位置，若通知记录了当时屏幕的标签则逐项核对。
- 超出通知范围的编号：屏幕上该行若是自由回答/讨论行 → 提示改用关键字（不按键）；若是实质行 → `confirm`。
- 执行（`executeBinding`）：以解析到的光标行为原点计算 Down/Up 次数；写入导航键后等待屏幕更新（`waitForTerminalVisibleLines`，1.5 秒内），要求光标恰好落在目标行且标签相等，再写 Enter（多选为逐项 Space，最后 Enter）。确认失败不按任何键，回复用户终端当前菜单。随同选择发送的文本（`inlineFollowUp`）在 Enter 后等待一次屏幕更新再写入。
- 命令：「菜单」重发终端当前菜单；「确认 N」选择终端第 N 项（仍经两阶段确认）。
- 无屏幕可读（渲染进程从未上报且无镜像），或已有新输出而屏幕在 1 秒内没有跟上时，一律拒绝按键，而不是按通知形状或旧画面盲发。

入站消息只接受 `from.userid` 与配置的接收用户 userid 完全相同的单聊（配置值必须是企业微信回调里的实际值，可能是加密形式）；其他发送者即使持有有效回复码也被静默忽略，不回复、不记录为拒绝，避免向陌生人确认回复码的存在。

通知侧只陈述确定的事：问题通知只给 Claude 自己的选项编号，自由回答与讨论以关键字提供；权限/计划通知在推送前尝试读取已画出的菜单，并要求首/末行语义正确、权限对话框含请求内容、计划菜单的行文提到 plan/edits/计划且**必须是 Hook 到达之后绘制的**（计划菜单没有可区分新旧的内容，Hook 之前的屏幕一律不采信），否则等待新输出，超时回退 Hook 数据。

### C 层：主进程屏幕镜像（`terminal-screen-mirror.ts`、`session-manager.ts`）

- `@xterm/headless` 不在默认依赖中（避免在无法更新 lock 文件的环境里破坏 `npm ci`），用 `npm install @xterm/headless@^6.0.0` 一次性写入 package.json 与 lock 后启用。安装后，每个会话在主进程持有一个与 renderer 同尺寸、同配置（无 Unicode 11 addon、`convertEol: false`）的 headless Terminal，PTY 输出同步写入，`resize` 同步跟随。每块字节解析完成后立刻以该输出序号发布可见行；此时渲染进程的上报被忽略。
- 未安装时 `loadHeadlessTerminalFactory()` 返回 null，行为退回渲染进程上报，启动日志给出提示。
- 任何 xterm 升级必须同时升级 `@xterm/xterm` 与 `@xterm/headless` 并保持配置一致，否则两端换行可能不同。

## 残余风险与运维说明

- A 层依赖 Claude Code 支持决定型 Hook 响应（2025-10 之后版本）；更老版本会在 Hook 超时（1 小时）后才显示对话框，此时应关闭“离开电脑时由企业微信直接代答”。
- B 层“读屏到写键”之间仍有毫秒级窗口；本地输入会使回复码失效，把窗口压到极低。
- 诊断：机器人卡片的“最近 Hook”会记录挂起、交还、Claude Code 放弃等待等事件；拒绝消息中总是附带终端当前菜单。
