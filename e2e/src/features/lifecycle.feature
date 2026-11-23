# language: zh-CN

功能: 桌面资源生命周期

  @lody @P0 @essence @runtime-simulator @LODY-SESSION-001
  场景: 用户停止并关闭一个真实 ACP Session
    假如 已配置确定性 Agent 的隔离桌面
    当 用户创建一个持续运行的 Session
    并且 用户停止当前 Agent
    那么 关闭 Session 后 Agent 进程被释放

  @lody @P1 @essence @runtime-simulator @LODY-REVIEW-001
  场景: 用户反复查看和隐藏大型本地 diff
    假如 已配置确定性 Agent 的隔离桌面
    并且 已注册包含大型变更的合成项目
    当 用户创建 Session 并打开全部变更
    并且 用户切换大型 diff 并隐藏再恢复 Review
    那么 关闭 Review 和 Session 后相关视图被释放

  @lody @P0 @essence @runtime-simulator @LODY-WORK-001
  场景: 用户删除带 ACP 和 Terminal 的 worktree Session
    假如 已配置确定性 Agent 的隔离桌面
    并且 已添加干净的合成 Git 项目
    当 用户创建 worktree Session 并启动 Terminal
    那么 永久删除后 Work 进程、终端和 worktree 被释放
