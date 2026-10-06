# WIN-WORKSPACE-001：Claude 工作台 Windows 交付整改

状态：整改中，未通过统一 Windows 验收。负责人：项目维护者。优先级：P1。

## 目标

把当前 claude-workspace-client 的用户身份统一为桌面工作台，首个标准版本使用：

- 工程/包名：claude-workspace
- 用户显示名：Claude 工作台
- 用户目录：%USERPROFILE%\claude-workspace\
- 配置：%USERPROFILE%\claude-workspace\config\settings.json
- MCP 注册名：不适用；工作台不得偷偷注册或管理其他三个 MCP 的运行时

本工程仍是独立桌面应用，不承担邮件、数据库或浏览器工程的安装、升级、配置和卸载。

## 整改内容

1. 统一 package/product/app 标识和公开文档中的 -client 后缀；应用内部模块可保留技术名称，但用户入口、7z 名称和安装目录使用 claude-workspace。
2. 公开发布只保留 claude-workspace-<version>-windows-x64.7z。7z 顶层直接提供现有发布的 Claude Workspace.exe 或 EXE 安装器作为唯一主入口，并提供中文 README.md、START-HERE.html、OPEN-CONFIG.cmd、STATUS.cmd（或等价入口）、config/settings.example.json、release-manifest.json 和 SHA256SUMS.txt；用户使用 Windows 版 7-Zip 或其他兼容工具解压。Claude 工作台不要求 INSTALL.cmd；NSIS/ZIP 等可以作为构建中间产物，但不能成为额外用户下载项。
3. 发布 EXE 或 EXE 安装器同时承担首次启动/安装和升级入口：版本目录、活动版本、锁和回滚记录只在 %USERPROFILE%\claude-workspace\ 下维护；配置和用户数据位于版本目录外；验证失败恢复上一版本。便携 EXE 的卸载是删除程序文件，安装器 EXE 使用自身卸载能力，两者都默认保留配置和用户数据。
4. 提供本工程的 OPEN-CONFIG.cmd 和机器可读 STATUS.cmd（或等价命令），使 Claude Code 能直接定位设置文件、用户数据和日志位置并读取应用版本/运行状态；如果应用配置由 UI 管理，必须同时提供可脚本化的导出/重载方式，不能要求用户在 AppData 深层目录盲找。
5. Windows CI 产出 7z、清单、逐文件 SHA256、运行时来源、许可证和 SBOM，并在干净 Windows x64 做安装、启动、升级、回滚、卸载冒烟。目标机不需要 npm、pnpm、npx、Docker 或在线下载。
6. 中文 README/HTML 写清解压、安装、首次启动、配置路径、工作区数据位置、升级、回滚、卸载和常见故障；更新构建和运行手册，移除把多个工程打包为一个产品的暗示。

## 验收证据

- [ ] 干净 Windows x64 + PowerShell 5.1 解压后直接双击发布 EXE 或 EXE 安装器，并成功启动工作台；不依赖 INSTALL.cmd。
- [ ] Claude Code/用户可通过 OPEN-CONFIG.cmd 和状态说明找到配置、日志和用户数据位置。
- [ ] 新版覆盖安装保留设置和用户数据；模拟启动失败时可恢复旧版本。
- [ ] 安装、升级、卸载不读取、修改或清理 mail、database、browser 工程目录或 MCP 注册。
- [ ] 公开下载项只有一个 7z，归档中没有真实凭据，并随包提交清单、哈希、许可证和 SBOM。

## 与 MCP 服务任务的边界

Claude 工作台是桌面客户端，不是 MCP 服务。本任务不要求 MCP 注册名、MCP 工具、initialize.instructions 或 stdio 握手；这些要求只适用于邮件、数据库和浏览器三个 MCP 工程。

客户端验收以发布 EXE 的进程启动、窗口可用、工程目录可选择、退出/再次启动、配置和用户数据保留为准。若客户端依赖本机 Claude Code CLI，发布 EXE 只检查并提示前置条件，不负责安装、升级或注册该 CLI，也不修改其他 MCP 的注册。

STATUS.cmd（或等价命令）必须返回应用版本、配置绝对路径、用户数据路径、日志路径和运行状态。配置重载可以采用客户端重启或明确的 reload 命令，README 必须给出实际步骤。

## 完成定义

应用标识、Windows 入口、配置可发现性、CI 制品和验收证据全部完成，并在任务总表登记最终版本与哈希后，才可把状态改为“已验收”。
