# 本地项目 Git 生命周期

Status: draft
Translation: current

[English](local-project-git-lifecycle.md)

## 场景与责任

本地项目拥有者观察仓库事实或切换分支。Git 工作流由 Effect 编排，路径、主机配置和进程 spawner 通过 Layer 提供。每条命令拥有进程 Scope，并行观察在报告失败前等待取消和有界进程树清理。调用方可以中断原生工作并等待清理。未解决的进程树保留为携带恢复租约的释放失败。

预期的非仓库、bare 根目录、缺失 ref、detached HEAD 和缺失可选配置保留其领域含义。进程启动、超时、输出限制、信号终止、权限或 I/O 错误、仓库损坏及释放失败不能被转换为成功的缺失结果。精确 ref 验证保留现有 namespace 和 selector 行为；若 ref 在读取 hash 前消失，观察失败。上限保持探测五秒、checkout 三十秒、每个输出流十六 MiB，并使用已有有界 abandonment 策略。

符号链接别名下的规范根路径和持久化项目 ID 保持稳定。纯 hash 与分支 planner 保持普通函数。每条命令通过提供的能力读取主机环境，runtime 初始化后的变化仍可见，原生 Git 认证不变。兼容执行只有一个可见的 deprecated Legacy 门面，运行同一内核，显式 runner 支持取消信号。同步文件系统方法仍阻塞。待应用 runtime 拥有全部 CLI 消费入口后删除门面。

本单元不迁移 worktree 创建或 GC，不新增跨进程 Git 修改串行化，不回滚中断前已执行的命令，也不完成 Session、ACP、Turn 取消。进程树清理不代表全部外部资源释放或 stdio 排空。真实 Windows 根退出后的后代所有权仍属于独立工作。

## 证据

- 实现与所属套件：`packages/shared/src/node/local-project.ts`、`packages/shared/tests/local-project.test.ts`。
- [决定](../.agents/notes/implemented/architecture/2026-10-10-effect-local-project-git.zh.md)。
- [进程释放契约](process-scope-release.zh.md)。
