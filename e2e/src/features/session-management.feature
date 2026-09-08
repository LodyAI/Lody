# language: zh-CN
@lody @essence @P1 @runtime-none @LODY-SESSION-002
功能: 本地 Session 元数据与归档恢复

  场景: 用户管理本地 Session 并保留其历史
    假如 已进入无需模型运行时的隔离桌面
    并且 已存在包含合成历史的本地 Session
    当 用户重命名并置顶该 Session
    那么 重命名和置顶状态在离开 Session 后仍可见
    当 用户归档并从 Archive 恢复该 Session
    那么 恢复后的 Session 保留标题、置顶状态和历史
    当 用户永久删除恢复后的 Session
    那么 Session 已从列表和路由中清理
