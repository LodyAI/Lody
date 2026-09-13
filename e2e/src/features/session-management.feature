# language: zh-CN
功能: 本地 Session 元数据与归档恢复

  @lody @essence @P1 @runtime-simulator @LODY-SESSION-002
  场景: 用户管理本地 Session 并保留其历史
    假如 用户已在隔离桌面配置确定性 Agent
    并且 用户从 New chat 创建了包含真实历史的 Session
    当 用户重命名并置顶该 Session
    那么 重命名和置顶状态在离开 Session 后仍可见
    当 用户归档并从 Archive 恢复该 Session
    那么 恢复后的 Session 保留标题、置顶状态和历史
    当 用户永久删除恢复后的 Session
    那么 Session 已从活动列表和 Archive 中清理

  @lody @essence @P1 @runtime-simulator @LODY-SESSION-004
  场景: opener 删除不销毁独立 opened Session
    假如 已配置支持分叉的确定性 Agent 桌面
    并且 已建立含 child Tab 和两个独立 worktree 的 Session 关系
    当 用户归档并永久删除 opener Session
    那么 child Tab 被删除而 opened Sessions 和 worktree 保留
    并且 metadata 未完成 hydration 时精确删除 empty child Tab 仍成功
