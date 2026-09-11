# language: zh-CN
@lody @essence @P1 @runtime-simulator @LODY-SESSION-003
功能: Session 未读状态与阅读恢复

  场景: 用户将另一个 Session 标记为未读并通过打开它清除状态
    假如 用户已在隔离桌面配置未读状态测试 Agent
    并且 用户通过 New chat 创建了两个 Session
    当 用户在第二个 Session 中将第一个标记为未读
    那么 第一个 Session 显示未读状态
    当 用户从侧栏打开第一个 Session
    那么 其历史可见且未读状态被清除
    当 用户从界面永久删除两个 Session
    那么 两个 Session 均已从活动列表和 Archive 中清理
