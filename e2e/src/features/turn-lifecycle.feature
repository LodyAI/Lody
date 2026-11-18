# language: zh-CN

功能: Turn 生命周期在权限请求、Agent 崩溃和桌面重启后保持可用

  @lody @P1 @essence @runtime-simulator @LODY-TURN-001
  场景: 权限批准只送达一次，Agent 崩溃后 Turn 被释放且后续消息在新进程中执行
    假如 已配置 Turn 生命周期用的确定性 Agent 隔离桌面
    当 用户启动一个等待权限批准的 Session
    并且 用户批准该权限请求
    并且 用户发送一条会让 Agent 进程崩溃的消息
    那么 崩溃的 Turn 被释放且后续消息在新的 Agent 进程中按顺序执行

  @lody @P1 @essence @runtime-simulator @LODY-TURN-002
  场景: 桌面冷重启后重新打开的 Session 接收后续消息且只执行一次
    假如 已配置 Turn 生命周期用的确定性 Agent 隔离桌面
    当 用户完成一个 Turn 后冷重启桌面
    那么 重新打开该 Session 后发送的后续消息只执行一次且回复排在消息之后
