# language: zh-CN
@lody @essence @P1 @runtime-simulator @LODY-SEARCH-001
功能: 侧栏 Search 定位本地 Session

  场景: 用户在多会话中搜索、重命名并清理 Session 索引
    假如 用户已在隔离桌面配置侧栏搜索测试 Agent
    并且 用户通过 New chat 创建了目标、相似标题和不匹配标题的 Session
    当 用户用大小写和部分关键词搜索 Session
    那么 搜索只返回匹配的 Session，清空后完整侧栏列表仍可见
    当 用户在搜索目标 Session 后将其重命名
    那么 搜索索引移除旧标题并返回新标题
    当 用户从搜索结果打开重命名后的目标 Session
    那么 目标 Session 的历史可见
    当 用户重新载入界面
    那么 已命名的 Session 及其搜索索引在隔离桌面中保持可用
    当 用户归档目标 Session
    那么 搜索索引不再返回归档目标但保留其他匹配 Session
    当 用户永久删除归档目标
    那么 搜索索引不再返回已删除目标
    当 用户从界面永久删除其余搜索 Session
    那么 所有搜索 Session 均已从活动列表和 Archive 中清理
