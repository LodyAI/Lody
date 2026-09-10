# 本地项目的 ACP 会话归属

Status: draft
Translation: pending

## 场景

用户为一个本地项目创建多个 Worktree 对话时，对话应在支持项目归属的提供方中
关联到同一原始项目，同时在各自 Worktree 中执行。Lody 项目记录决定逻辑根目录，
实际执行目录不能被项目归组替换。

## 责任与协议

Lody 从本机本地项目目录中按 `localProjectId` 解析根路径。仅当 ACP 适配器通过
`agentCapabilities._meta.lody.worktreeProject = { version: 1 }` 声明支持时，Lody
在建立会话的 `session/new`、`session/load`、`session/resume`、`session/fork`
请求中发送 Core 定义的元数据：

```json
{
  "cwd": "/worktrees/task-a",
  "_meta": {
    "lody": {
      "worktreeProject": { "version": 1, "originProjectPath": "/original/project" }
    }
  }
}
```

元数据表达本地项目归属，不授予目录权限、不修改工作区访问范围，也不移交
Worktree 创建或清理责任。预创建、恢复、共享目录的子会话和替换会话保持这一
分工。GitHub-only 和无项目会话不推断本地项目根路径。

Codex 适配器复用根路径匹配的原生项目，缺失时幂等创建；新线程直接关联项目，
fork 仅关联目标线程。加载或恢复已有线程时，仅补齐空的归属，保留既有项目选择。
客户端省略该扩展时维持原有行为，不清空归属。多个原生项目匹配同一根目录时
报明确错误；支持该扩展的调用失败时也不能静默宣称已完成关联。

## 范围与验证

此次修复覆盖本地项目原生归组和重开会话时的补归属，不批量迁移历史。
标准 `session/list.cwd` 仍按执行目录查询。项目级历史查询、桌面 Worktree 徽标
和 Handoff 不在这项保证内。

实现已有能力协商、创建、load/resume、fork、项目复用、路径别名和幂等验证。
隔离的 Codex 0.153.4 验证确认实际适配器创建、恢复补归属和 fork 后，三个线程
保留 Worktree cwd 并在原生状态库关联同一项目。模型目录发现被离线替代，未运行
模型推理或修改真实历史。本 Spec 仍为 draft，发布和跨版本桌面展示尚未验证。

## 证据

- [Core 契约](../packages/acp-extension-core/README.md)
- [宿主建立会话](../apps/cli/src/agent/agent-client.ts)
- [原始根目录解析](../apps/cli/src/session/session-manager.ts)
- [Codex 项目映射](../packages/acp-extension-codex/src/WorktreeProject.ts)
- [调查与初始提案](../.agents/notes/proposed/architecture/2026-09-08-codex-worktree-project-persistence.zh.md)
