# 将 CodeMode 用作自动化条件解释器

Status: proposed
Translation: current

[English](2026-10-28-codemode-automation-interpreter.md)

## 摘要

Lody 当前在受限的 QuickJS worker 中执行持久化的 JavaScript 条件。OpenCode CodeMode 可以作为替代解释器的候选，功能尚未发布，因此无需兼容此前的开发脚本；删除现有实现前仍需验证生命周期和资源行为。本地实现已直接使用 CodeMode，完整构建和打包验证仍待完成。条件与执行契约由现有的[自动化协调方案](2026-10-25-session-automation-coordinator.zh.md)维护。

## 证据与方案

- QuickJS 接收函数表达式和受限的 `ctx.read`；worker 客户端负责 30 秒超时、最多 32 次读取、四个并发读取、终止和等待资源所有者读取结束。解释器还限制 QuickJS 内存、栈和指令，并验证结果、拒绝未完成的读取。条件会跨重启持久化，但功能尚未发布。
- 已发布的 `@opencode/codemode` 2.2.0 提供 Effect 原生工具和受限 JavaScript 解释器。仓库外的临时实验将 `ctx.read` 适配成工具，成功运行简单条件和 README 中 CI 示例的 `flatMap`/`filter` 写法；无限循环返回 `TimeoutExceeded`。直接包装末尾带分号的函数文件会解析失败，未等待的即时读取则返回成功。实验范围有限，不能作为兼容性或安全认证。
- 发布包依赖 Effect 4.0.1，而 Lody catalog 固定为 4.0.2。临时实验中，两份 Effect 版本导致工具结果变为 undefined；统一使用 Lody 的 4.0.2 后，简单条件和 CI 条件实验恢复正常。工作区已为 CodeMode 的依赖配置 4.0.2 覆盖，CLI 已依赖 CodeMode 2.2.0；根据用户要求，仅豁免该版本的七天最短发布时间；独立 pnpm 安装已确认二者均解析到 4.0.2。仍需在不修改 Lody 锁定版本的前提下检查模块身份、类型、中断和打包。CodeMode 公开超时、工具次数和输出限制，但没有等价的公开指令、栈或内存预算；输出限制不能约束解释器堆。执行边界应根据取消和资源行为的测试结果确定，无需保留 QuickJS 和 WASM 隔离。
- 直接采用 CodeMode 语言，同步更新调用方和示例；未发布脚本不需要兼容适配器或语言版本。继续保证范围授权、结果验证、读取限制与取消。验证注册校验、对抗输入、中断、资源行为和打包。

本地实现删除 QuickJS，并在现有 Effect scope 中直接运行 CodeMode。测试覆盖条件、MCP 示例、受限读取和取消；此工作区的完整类型检查和桌面打包尚未验证。
