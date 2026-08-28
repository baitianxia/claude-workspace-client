# Session Host 架构规范

状态：当前、规范性文档  
适用范围：客户端退出、会话生命周期、手动版本升级、Session Host 打包与兼容性

## 目标

Claude Code 会话的生命周期不再等同于 Electron 客户端窗口的生命周期。用户关闭客户端时，如果有会话运行，必须明确选择：

1. 仅退出客户端，会话继续运行；
2. 退出客户端，并结束所有会话；
3. 取消。

本功能服务于手动安装或替换客户端版本。项目当前没有自动更新流程，本设计不引入自动下载或静默安装。

## 进程与所有权

```text
Renderer ──受限 IPC──> Electron Main ──鉴权命名管道──> Session Host ──> node-pty ──> Claude Code
                                                  └──> HTTP Hook Server
```

- Electron Main 负责窗口、项目配置、文件查看、系统安全存储和企业微信连接。
- Session Host 是当前用户下独立、无界面的 Node.js 进程；Windows 进程名为 `Claude Workspace Session Host.exe`，负责 PTY、终端内存缓冲、会话运行状态、launch ID 和 Claude Code Hook 服务。
- 从创建会话开始，PTY 必须由 Session Host 直接创建并持有。正在运行的 PTY 不能在客户端退出时临时转移给另一个进程。
- Electron Main 只持有 Session Host 客户端连接。退出客户端时关闭该连接不得调用 PTY 的 `kill`。

## 关闭流程

只有存在 `starting` 或 `running` 会话时才显示选择框。

- “仅退出客户端（会话继续运行）”：关闭企业微信连接、IPC 和 Host 客户端连接，然后退出 Electron；不发送停止会话请求。
- “退出并结束所有会话”：先向 Host 发送 `stopAll`，确认 Host 已接受终止请求后退出 Electron。
- “取消”：窗口和所有连接保持不变。

窗口关闭、任务栏退出和 `app.quit()` 必须复用同一决策流程，不能存在绕过选择框并隐式结束会话的退出路径。

## 手动升级流程

1. 用户在旧客户端中选择“仅退出客户端（会话继续运行）”。
2. 独立 Session Host 和 Claude Code PTY 继续运行。
3. 用户手动运行安装包或使用新 ZIP 目录。安装器不得强制结束客户端；若发现客户端仍在运行，只允许用户返回客户端处理后重试或取消。
4. 新客户端使用稳定的每用户端点和令牌连接现有 Host。
5. 新客户端从 Host 获取会话、launch ID 和终端缓冲，替换 `workspace.json` 中的会话镜像。

Session Host 的可执行运行时必须先复制到 `%APPDATA%\Claude Workspace\session-host\versions\runtime-<版本>`，然后从该目录启动。Host 不得从客户端安装目录或 `app.asar` 加载代码、Node.js 或 `node-pty`，否则运行中的 Host 会锁住待替换文件。

## 数据边界

| 数据 | 所有者 | 持久化 |
| --- | --- | --- |
| 工程、Claude 路径、企业微信加密配置 | Electron / `ProjectStore` | `workspace.json` |
| 会话元数据和状态 | Session Host | `session-host/state.json`，原子写入 |
| PTY 与 launch ID | Session Host | 仅内存 |
| 终端输出缓冲 | Session Host | 仅内存，单会话最多 2,000,000 字符 |
| Host 鉴权令牌 | Host Launcher | `session-host/auth-token`，仅当前用户可读写 |

`workspace.json` 中的会话只是界面镜像，不得覆盖一个已经存在的 Host 状态。仅在第一次启动 Host、且 Host 状态文件尚不存在时，允许导入旧的会话标签；导入时旧的 `running` / `starting` 记录必须转换为 `interrupted`。

## 安全约束

- Windows 使用按用户数据目录派生的稳定命名管道；其他开发平台使用临时 Unix socket。
- 连接首先交换协议版本和 256 位随机令牌。令牌比较使用恒定时间比较。
- 未鉴权连接不能调用任何会话方法。
- JSON 行协议的单条消息和未完成请求数必须有上限；所有来自管道和状态文件的数据必须再次校验。
- Unix socket 权限设为 `0600`。Windows 仍必须依赖随机令牌，不能只依赖管道名称。
- Host 运行时必须携带其 Node.js 与 `node-pty` 许可文件，并在 Windows 目标平台上构建，避免复制错误平台或 ABI 的原生模块。

## 生命周期与故障语义

- 没有客户端连接且没有运行中会话时，Host 延迟退出；状态元数据保留，终端内存缓冲释放。
- 仍有运行中会话时，即使没有客户端连接，Host 也不得因空闲退出。
- Host 崩溃、被用户结束、Windows 注销或关机会中断其 PTY。下次启动时，状态文件中的 `running` / `starting` 会话显示为 `interrupted`。
- 企业微信 WebSocket 仍属于 Electron Main。客户端关闭期间会话继续运行，但不能实时远程回复；Host 最多暂存有限数量的 Hook 事件，客户端重新连接后再处理。
- Session Host 连接异常时，客户端必须明确告知用户，不得假装本地缓存仍代表真实运行状态。

## 版本兼容规则

- 命名管道协议有独立 `protocolVersion`，Host 运行时有 `runtimeVersion`。
- 为保证跨版本会话连续性，后续客户端必须能连接仍持有运行中会话的旧 Host；不得因为运行时版本不同而强制结束或替换它。
- 只有旧 Host 没有运行中会话时，新客户端才可请求其退出并启动当前运行时。
- 对协议做不兼容修改前，必须设计至少一个可跨版本迁移的兼容阶段。不能仅递增协议版本后占用同一端点启动新 Host。
- 修改 Host 可执行代码或依赖时必须递增 `SESSION_HOST_RUNTIME_VERSION`，确保新的文件复制到新版本目录，不覆盖可能正在执行的旧运行时。

## 首次迁移限制

旧版本由 Electron Main 直接持有 PTY。操作系统和 `node-pty` 不支持把已运行的 PTY 无损转移给新的 Host，因此首次安装本架构时，旧版本已经启动的会话不能保活。这是一次性迁移边界；安装后新建或重启的会话由 Host 持有，后续手动升级可继续运行。

## 验证要求

相关改动至少验证：

- 客户端断开不会调用 PTY `kill`；
- 新客户端连接相同端点后得到相同会话 ID、运行状态和终端缓冲；
- 重连后仍能向原 PTY 写入；
- `stopAll` 会向所有运行中 PTY 发出终止请求；
- 错误令牌不能通过握手；
- Host 状态原子写入，损坏文件被隔离而不是直接采用；
- Windows 构建包含安装目录外可启动的 Node.js、编译后 Host 代码和 `node-pty`；
- 安装器发现客户端运行时不会强制结束进程。
