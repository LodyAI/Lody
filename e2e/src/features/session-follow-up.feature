# language: zh-CN

功能: 空闲 Session 中的连续消息

  @lody @P0 @essence @runtime-simulator @LODY-SESSION-005
  场景: 用户在已完成回复的 Session 中连续发送的每条消息都按顺序执行一次
    假如 已配置确定性 Agent 的隔离桌面
    当 用户创建一个已完成首轮回复的 Session
    并且 用户在同一 Session 中逐条发送两条后续消息
    那么 Agent 按发送顺序各执行每条消息一次
    并且 关闭 Session 后 Agent 进程被释放
