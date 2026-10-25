# 隔离 ACP 能力探测工作目录

Status: implemented
Translation: current

[English](2026-10-25-acp-probe-workdir.md)

## 摘要

Issue [#1844](https://github.com/LodyAI/Lody/issues/1844) 报告 daemon 继承 `/` 后，Antigravity 因创建工作区级 `.gemini/skills` 失败而无法发现能力。现在所有 provider 的能力探测都会分配独立临时目录，保留 provider 凭据及真实会话的项目目录。启动失败、取消及结果处理失败均会在现有 agent 清理之后进入目录清理。清理仍是尽力而为：删除失败不能替代探测结果，runner 现有的 shutdown 契约也不保证进程已经终止。

## 决策与资源归属

[`fetchAcpCapabilities`](../../../../apps/cli/src/agent/acp-capabilities.ts) 每次调用持有一个 `mkdtemp` 目录，将同一绝对路径传给 runner 用于进程启动和 `session/new`。认证预检仍在分配前进行，分配期间到达的取消会在启动 agent 前检查。外层 `finally` 在内层 agent shutdown 或启动失败清理之后尝试递归删除目录。启动门控和现有 AbortSignal 传递保持不变。

目录创建失败明确拒绝，不回退到继承的 cwd。删除失败输出固定诊断，保留已发现能力或原始探测错误，即使日志输出也失败。后续探测分配新路径，目录占用不会阻塞其他 provider 或重试。不删除凭据、provider home 或用户项目。

现有 runner 捕获进程终止失败并记录残留进程。本次保留该契约及此前 Codex 探测的尽力删除语义；shutdown 返回不被视为退出证明，仍可能残留临时文件或进程。不增加进程监督器、保留失败注册表或重试循环。

## 范围与替代方案

[能力缓存决策](../../implemented/bug-fix/2026-09-16-acp-capability-refresh-cache.md) 要求探测真实 runtime，本次保留 runtime/缓存行为，不替换成静态能力。回退到用户主目录虽可避开根卷错误，仍会混合探测文件和用户配置。全局 `process.chdir` 会影响并发 daemon 工作。独立临时工作区能隔离并发探测，避免以上影响。

Registry 认证仍单独使用继承的 cwd，但只初始化和认证协议，不创建本报告涉及的工作区会话，因此行为保持不变。真实项目会话不经过此次修改的函数。依赖 daemon 启动目录下相对文件的自定义命令应使用绝对启动路径；能力探测有意保持项目无关。

已按 feature/fix 模式及[选择指南](../../../docs/cli-effect-ts.md#small-migrations-during-feature-and-fix-work) 评估原生 Effect 迁移。启动、认证和停止仍属于未迁移的 Promise 编排，包装它们不能完成原生单元。本次保留现有归属，不扩大迁移范围。

## 验证

能力探测与 runner 两套测试共 44 项通过。新增行为测试将继承 cwd 报告为根目录，并在传入目录实际创建 `.gemini/skills`；覆盖 registry/custom/builtin、并发探测与延迟 shutdown、启动及归一化失败、目录分配及启动期间取消、目录创建和删除失败、删除失败后的重试、日志抛错、shutdown 意外拒绝，以及验证失败后 Codex profile home 保留。除显式注入的失败边界外，文件系统操作是真实的；并发使用显式信号，不使用睡眠。

仓库类型检查、lint、格式化、文档及边界检查通过。完整 `pnpm test:ci` 在系统 Git 环境（`env -u GIT_EXEC_PATH PATH="/usr/bin:/bin:$PATH"`）下通过；继承的会话 Git 包装器会使一个无关的合成 SSH 用例报 `context_unreadable`。

未实际执行 Antigravity 登录或模型回复。测试验证宿主工作区归属，不代表已验证上游 provider 内部实现。
