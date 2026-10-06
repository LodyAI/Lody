# 新建 worktree 分支的可读名称

Status: proposed
Translation: current

[English](2026-09-27-readable-worktree-branches.md)

## 摘要

#289 指出 worktree 的随机分支名让会话工作难以辨认和发布。建议先保留 ID 分支，
待首个有效标题到达后，仅对新的、未变化且未发布的分支改名，并对账 Git 与会话元数据。
参考实现已记录持久的一次性改名意图，并在操作前核实 Git 分支、HEAD 和远端发布
状态。issue 的体验反馈与投稿来源交接尚未完成，设计仍标为 proposed。

## 决定与替代方案

只把 `SessionConfig.title` 传给分支分配器不足以解决问题：标题可缺省，推测性
worktree 在持久会话之前建立，而 Provider 标题在初始化后才到达。由初始提示词
直接派生名称会越过准备 RPC 不传草稿文本的约定，还可能把敏感信息放进公开分支名。
按标题变化改名所有现有 `lody/<id>` 分支则会影响旧会话和可能已经推送的分支。
记录初始分支与 HEAD 的新会话一次性标记，才有明确的适用边界。

[Spec 草案](../../../../specs/readable-worktree-branches.zh.md)建议等标题被接受后，
只在分支及发布状态未变化时改名；真实 Git 引用与 `SessionMeta` 必须有恢复对账
路径。单独的短名转换辅助函数不会产生用户可见价值。

## 证据与状态

- 撰写时 [需求 #289](https://github.com/LodyAI/Lody/issues/289)没有维护者讨论或
  对应的其他实现。
- 当前 [worktree 创建](../../../../apps/cli/src/session/worktree/worktree-manager.ts)
  早于标题生成；[ACP 标题 Spec](../../../../specs/acp-session-titles.zh.md)记录了较晚的
  Provider 事件。
- 参考分支现有受限 ASCII 短名、`SessionMeta` 中的一次性意图和仓库锁保护的 Git
  改名。本地 Git 定向测试覆盖未改动分支、HEAD 已移动、已发布引用、碰撞后缀及
  无法转换的标题。SessionManager 测试覆盖推测性接管资格与 Git 改名后的恢复；
  标题回调时序仍需集成验证，才能准备上游 PR。
- 没有上游 PR。fork PR 的公开会话交接是独立门槛；本文不声称用户已发布或批准。
