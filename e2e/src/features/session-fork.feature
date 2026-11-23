# language: zh-CN

功能: Session 分叉到独立 worktree

  @lody @P1 @essence @runtime-simulator @LODY-FORK-001
  场景: 用户把已完成 Session 分叉到独立 worktree 后清理分叉
    假如 已配置支持分叉的确定性 Agent 桌面
    并且 已添加用于 Session 分叉的干净合成 Git 项目
    当 用户把已完成的源 Session 分叉到新 worktree
    那么 分叉保留来源和对话且删除后不改变源 Session
