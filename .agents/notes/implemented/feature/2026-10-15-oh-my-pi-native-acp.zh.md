# 通过本地 ACP 注册表接入 Oh My Pi

Status: implemented
Translation: current

[English](2026-10-15-oh-my-pi-native-acp.md)

## 摘要

已安装 Oh My Pi 的用户此前只能手动配置它的 ACP 命令。
注册表现在提供独立的 `oh-my-pi` 入口，通过现有 Provider 生命周期启动用户的
`omp acp`，并识别 OMP 的默认技能目录。Windows 退出逻辑同时核实 taskkill 状态码
128 是否确实表示进程已退出，使拒绝正常结束的控制台进程可以继续执行强制清理。
此接入依赖 OMP 实际声明的标准 ACP
能力，不提供终端组件或独立的 Lody Core RPC 适配器。

## 决策与范围

沿用 OpenCode 等 Provider 的本地启动方式，在版本元数据中声明 `--version` 参数。
远端注册表为相同 ID 提供元数据时，生成器仍保留本地启动命令。
此改动不引入 OMP 下载、受管理运行时清单、协议桥接或 Pi 迁移。
凭据和自定义 profile 继续由 OMP 管理。
Provider 搜索包含本地可执行命令，因此远端元数据替换默认描述后，仍能搜索 `OMP`。

上游[原生 ACP 提案](https://github.com/LodyAI/Lody/issues/1264)还包括斜杠命令传输
和交互组件，这些工作单独推进。[RPC 适配器提案](https://github.com/LodyAI/Lody/issues/930)
涉及额外的 Core 语义和独立发布的适配器。本次注册表改动不关闭这两个 Issue。

[OMP v18.11.0 的 ACP 实现](https://github.com/can1357/oh-my-pi/blob/v18.11.0/packages/coding-agent/src/modes/acp/acp-agent.ts)
定义原生协议。它的配置和技能发现使用 OMP 自身的 profile。
静态技能目录表只添加默认 `.omp/skills` 和 `~/.omp/agent/skills`，
不推断命名 profile 的目录。同时提升技能缓存版本，使已有安装重新扫描扩展后的目录列表。

## Windows 进程清理

通过 Lody 的实际 ACP 启动路径测试 OMP 时发现已有进程管理缺陷：
`taskkill /T` 在 PID 不存在和控制台进程需要 `/F` 时都会返回 128。
统一将其视为成功会导致 OMP 及其 MCP 子进程残留。
共享 Windows 进程模块现在仅在 Node 已观察到根进程退出时，将 128 视为进程消失。
仍存活的根进程继续走现有的正常退出到强制退出流程；强制退出被拒绝时，
向所属作用域报告 `TerminationFailed`。
清理由 ACP 关闭触发，现有进程租约负责退出及失败恢复，取消提示词仍使用 ACP 请求。
此改动不添加调用方的终止循环或新的所有权边界。
已退出的根进程不会再次按 PID 发送信号；根进程退出后的子进程追踪仍不在本次范围内。
模块已使用原生 Effect v4，无需迁移。

## 验证

生成器测试覆盖远端缺席时的入口、元数据合并、启动命令保持和去重。
CLI 测试覆盖启动解析与能力缓存身份。对话框测试覆盖搜索、保存、编辑，
以及从 Pi 切换时清除 Pi 专用配置。技能测试覆盖 OMP 默认目录。
Windows 回归测试复现子进程存活时的状态码 128，验证升级后父子进程均已退出，
并验证强制退出失败时显式报告错误。

官方 OMP v18.11.0 在 Windows x64 上通过 11 项原生 ACP 检查，以及 8 项通过
Lody 实际启动器和客户端执行的检查。验证使用隔离 profile、本机合成模型和 stdio MCP。
后者验证模型选择、流式输出、取消、精确会话恢复和 MCP 调用，两次关闭均从状态码
128 升级到 `/F`，未残留 OMP 或 MCP 进程，也未使用 stdin 关闭兜底。
真实认证、Electron 界面、权限界面、图片、HTTP/SSE MCP 及其他平台仍未验证。
完整检查结果和已复现的既有 Windows 测试失败记录在 PR 中。
