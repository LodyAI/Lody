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

## 首次任务的分支命名

普通新建的独立 Worktree 会话，无论 GitHub 还是本地项目，都在首次任务提示词中
要求 Agent 检查当前分支，在开始工作、提交或推送前，将 Lody 分配的临时引用
（`session/<id>` 或 `lody/<id>`，包含名称碰撞后缀）改成任务分支名。
Agent 保留已有的描述性任务分支，以任务摘要命名，避免将敏感输入复制进引用，
且不强制覆盖已有分支。名称冲突时选择其他描述性名称；改名失败时说明情况并继续任务。

触发条件按会话首次使用判断，包含采用预创建 Worktree 的情形。直接本地目录、
共享父目录的子标签页、已有 ACP 会话或明确请求恢复的会话、后续回合和独立的
Fork 流程，不收到这条首次任务要求。命名不依赖 Provider 类型，也不新增公共
API 或持久化标志。这是对 Agent 的指导，不保证模型一定执行改名。守护进程
不从提示词派生引用，也不启动额外的 ACP 生成器。现有 Git 观测发布 Agent 的
改名结果；Provider 推送会话标题的机制保持独立。

## 证据

- [分支状态归属](../apps/cli/src/session/workspace-git-service.ts)
- [执行生命周期](../apps/cli/src/session/session-execution-service.ts)
- [工作目录刷新](../apps/cli/src/lib/code-collab/code-collab-v2-service.ts)
- [决策与验证](../.agents/notes/implemented/bug-fix/2026-09-24-workspace-branch-observation.zh.md)
- [首次任务命名决策](../.agents/notes/implemented/feature/2026-10-08-new-worktree-branch-prompt.zh.md)
