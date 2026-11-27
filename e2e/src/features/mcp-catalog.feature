# language: zh-CN

功能: Workspace MCP 目录

  @lody @P1 @essence @runtime-simulator @LODY-MCP-001
  场景: 用户创建 MCP 并为一个 Turn 显式选择后删除目录项
    假如 已配置确定性 Agent 的隔离桌面用于 MCP 旅程
    当 用户创建一个合成 stdio MCP 服务器
    并且 用户在 composer 中显式选择该 MCP 服务器
    并且 用户发送一个完成的 Turn
    那么 bundled CLI 将该 Turn 的 MCP 选择传入 ACP 启动
    当 用户删除该 workspace MCP 服务器
    那么 目录项已删除且已完成 Turn 的 MCP 启动选择保持不变

  @lody @P1 @essence @runtime-simulator @LODY-MCP-003
  场景: 编辑已选中的 MCP 服务器配置后，同一 Session 下一轮重启 ACP 并加载新配置
    假如 已配置确定性 Agent 的隔离桌面用于 MCP 旅程
    当 用户创建一个合成 stdio MCP 服务器
    并且 用户在 composer 中显式选择该 MCP 服务器
    并且 用户发送一个完成的 Turn
    那么 bundled CLI 将该 Turn 的 MCP 选择传入 ACP 启动
    当 用户编辑该已选中的 MCP 服务器配置
    并且 用户在同一 Session 发送后续 Turn
    那么 bundled CLI 退役旧 ACP 并在新 ACP 启动时传入更新后的 MCP 配置
