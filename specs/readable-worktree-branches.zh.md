# 新建 worktree 会话的可读分支名

Status: draft
Translation: current

[English](readable-worktree-branches.md)

新建 worktree 会话目前先使用 `lody/<会话 ID>` 一类不可读分支名。标题通常在
worktree 和 Provider 启动后才出现。对于新会话，Lody 应在不会影响已发布的工作或
用户自行选择的分支时，以首次被接受的会话标题生成有长度限制的可读分支名。

## 职责

- worktree 创建不等待标题生成。推测性准备阶段不得接收草稿提示词或由提示词
  派生的名称；初始分支仍使用现有会话 ID 兜底名。
- 创建或接管 worktree 时，所属机器持久记录一次性改名意图，包括准确的初始分支
  与 HEAD。旧会话没有该标记，绝不因本功能自动改名。
- 首个有效标题到达后，所属机器将标题转换为小写 ASCII 短名，加上简短会话 ID
  后缀，并限制分支总长度。短名为空或不可用时保留初始分支。后续标题变化不再改名。
- 改名前确认 worktree 仍在记录的分支、HEAD 未移动，且分支没有上游跟踪、已发布
  的远端引用或关联 PR。发布状态不明时保留原名。在仓库锁内分配唯一且符合 Git
  规则的名称，避开本地引用命名空间冲突，绝不接入其他会话的分支。
- Git 与会话元数据不能原子修改。先持久化改名意图；Git 改名成功后，把实际分支
  写入 `SessionMeta.branchName`。恢复流程在使用元数据恢复或清理 worktree 前，按
  实际 Git 分支对账未完成意图。失败时保留原名，不无限重试。

本行为只影响新建 worktree 会话。直接使用本地目录的会话、子 Tab、恢复中的
worktree 和旧会话分支保持原行为。不得仅为了命名分支而从初始提示词复制文本；
分支以后可能被推送到公开远端。

## 验收场景

仓库自带测试需覆盖推测性准备后的接管与普通创建、Provider 生成和显式标题、
重复标题、非 ASCII 与空标题、用户已改名分支、HEAD 已移动、分支已发布，以及
Git 改名成功但元数据尚未写入时的恢复。每种场景都要核实 UI 中的会话分支、
真实 Git HEAD 引用和之后的恢复目标一致。

## 证据及待评审设计

- [需求 #289](https://github.com/LodyAI/Lody/issues/289) 要求新会话分支可读、唯一，
  且空标题或非 ASCII 标题有兜底。
- [worktree 分配](../apps/cli/src/session/worktree/worktree-manager.ts) 在会话运行前建
  分支；[推测性准备](../apps/cli/src/session/worktree/speculative-worktree.ts) 甚至可能
  在持久会话被接管前建分支。
- [标题归属](acp-session-titles.md)允许 Provider 在初始化后提供标题；
  [分支观察](workspace-branch-state.md)和 [worktree 生命周期](session-worktree-lifecycle.md)
  已依赖真实 Git 分支与持久会话元数据一致。

参考实现会在改名前检查本地 upstream、远端跟踪引用和远端分支；Git 更改引用前
先记录拟改名称，随后将实际分支对账回会话元数据。本地 Git 测试覆盖未改动分支、
HEAD 已移动、已发布引用、碰撞后缀与不可用标题。SessionManager 测试覆盖
推测性接管及 Git 改名后的恢复；标题回调时序仍需集成验证。本草案不是已批准的
行为保证。
