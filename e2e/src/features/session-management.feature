# language: zh-CN
@lody @essence @P1 @runtime-simulator @LODY-SESSION-002
功能: 本地 Session 元数据与归档恢复

  场景: 用户管理本地 Session 并保留其历史
    假如 用户已在隔离桌面配置确定性 Agent
    并且 用户从 New chat 创建了包含真实历史的 Session
    当 用户重命名并置顶该 Session
    那么 重命名和置顶状态在离开 Session 后仍可见
    当 用户归档并从 Archive 恢复该 Session
    那么 恢复后的 Session 保留标题、置顶状态和历史
    当 用户永久删除恢复后的 Session
    那么 Session 已从活动列表和 Archive 中清理
