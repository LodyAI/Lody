# language: zh-CN

功能: Turn 生命周期在权限请求、Agent 崩溃和桌面重启后保持可用

  @lody @P1 @essence @runtime-simulator @LODY-TURN-001
  场景: 权限批准只送达一次，Agent 崩溃后 Turn 被释放且后续消息在新进程中执行
    假如 桌面已进入一个可用的工作区
    并且 已配置 Turn 生命周期用的确定性 Agent
    当 用户启动一个等待权限批准的 Session
    并且 用户批准该权限请求
    并且 用户发送一条会让 Agent 进程崩溃的消息
    那么 崩溃的 Turn 被释放且后续消息在新的 Agent 进程中按顺序执行

  @lody @P1 @essence @runtime-simulator @LODY-TURN-002
  场景: 桌面冷重启后重新打开的 Session 接收后续消息且只执行一次
    假如 桌面已进入一个可用的工作区
    并且 已配置 Turn 生命周期用的确定性 Agent
    当 用户完成一个 Turn 后冷重启桌面
    那么 重新打开该 Session 后发送的后续消息只执行一次且回复排在消息之后

  @lody @P1 @essence @runtime-simulator @LODY-TURN-003
  场景: 桌面在 Turn 运行中正常退出并重启后，被打断的 Agent 自动继续
    假如 桌面已进入一个可用的工作区
    并且 已配置 Turn 生命周期用的确定性 Agent
    当 用户启动一个持续工作的 Turn
    并且 桌面在 Turn 运行中正常退出后重新启动
    那么 被打断的 Turn 无需用户操作就在新的 Agent 进程中继续一次

  @lody @P1 @essence @runtime-simulator @LODY-TURN-004
  场景: 桌面和 CLI 在 Turn 运行中被强制杀死并重启后，被打断的 Agent 自动继续
    假如 桌面已进入一个可用的工作区
    并且 已配置 Turn 生命周期用的确定性 Agent
    当 用户启动一个持续工作的 Turn
    并且 桌面和它启动的全部进程在 Turn 运行中被强制杀死后重新启动
    那么 被打断的 Turn 无需用户操作就在新的 Agent 进程中继续一次

  @lody @P1 @essence @runtime-simulator @LODY-TURN-005
  场景: 刚创建的 Session 在桌面和 CLI 被强制杀死后仍然列出并能打开历史
    假如 桌面已进入一个可用的工作区
    并且 已配置 Turn 生命周期用的确定性 Agent
    当 用户启动一个持续工作的 Turn
    并且 桌面和它启动的全部进程在 Turn 运行中被强制杀死后重新启动
    那么 被打断的 Session 仍然列出并能打开之前的对话
