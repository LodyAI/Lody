# language: zh-CN

功能: 运行中 Session 的消息队列

  @lody @P1 @essence @runtime-simulator @LODY-QUEUE-001
  场景: 用户取消排队消息后只按顺序发送保留消息
    假如 已配置消息队列用的确定性 Agent 隔离桌面
    当 用户启动一个持续运行的 Session
    并且 用户依次排队两条后续消息
    并且 用户从队列移除第一条后续消息
    那么 当前 Turn 完成后只有保留消息按顺序发送
