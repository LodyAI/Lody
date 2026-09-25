# 工作目录分支信息

Status: draft
Translation: current

[English](workspace-branch-state.md)

用户打开没有 GitHub 远端的本地 Git 项目时，对话应在与 Worktree 对话相同的
桌面信息栏和菜单中展示检出的分支。普通非 Git 文件夹不得获得虚构的分支。

## 归属与观测

所属机器在解析后的实际执行目录读取 Git。这项能力独立于仓库托管、PR 关联和
Agent 提供方。子标签页共享父会话的工作目录，将分支观测写入父会话；独立
Worktree 会话保留各自的分支。

激活或显式刷新根工作目录内容、绑定 Agent 会话，以及运行中的回合完成、取消或失败时
观测分支。启动和文件快照响应不等待展示元数据。按所属会话串行执行读取与写入，
避免较早的慢读取覆盖较新的检出结果。只发布变化，不需要远程 Git 或认证云请求。
普通文件监听与回合差异刷新不重复观测分支；失败回合发布失败状态时不等待可选分支观测。

`SessionMeta.branchName` 仍表示最近成功观测到的具名分支。Detached HEAD 或 Git
读取失败时保留它，以支持 Worktree 恢复与 PR 查询。不得用起始／基准引用冒充
当前分支。新建非 Git 会话没有分支。空闲时外部切换分支在下一次工作目录刷新或
回合中更新；此约定不承诺持续监听 Git HEAD。现有移动端布局仍不在底部栏展示分支文本。

## 证据

- [分支状态归属](../apps/cli/src/session/workspace-git-service.ts)
- [执行生命周期](../apps/cli/src/session/session-execution-service.ts)
- [工作目录刷新](../apps/cli/src/lib/code-collab/code-collab-v2-service.ts)
- [决策与验证](../.agents/notes/implemented/bug-fix/2026-09-24-workspace-branch-observation.zh.md)
