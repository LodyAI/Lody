# language: zh-CN

功能: MCP App 内嵌界面

  @lody @essence @P1 @runtime-simulator @LODY-MCPAPP-001
  场景: 用户在对话中打开 MCP App 并通过应用触发工具调用
    假如 已配置提供 MCP App 的确定性 Agent 隔离桌面
    当 用户发送会调用带界面工具的消息
    那么 对话中显示 "Opened Synthetic Board" 卡片且内嵌应用展示工具结果
    并且 内嵌应用运行在 opaque origin 中并能使用内存 storage 与 cookie
    当 用户在内嵌应用中触发一次应用可见工具调用
    那么 工具调用经 ACP 扩展方法往返并更新内嵌应用
    当 用户重新加载桌面主窗口
    那么 内嵌应用重新运行且之前写入的 storage 既未保留也未写入磁盘
