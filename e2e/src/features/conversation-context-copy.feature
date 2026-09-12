# language: zh-CN

功能: Session 上下文 Markdown 复制

  @lody @essence @P1 @runtime-simulator @LODY-CONTEXT-001
  场景: 用户跨消息边界、流式状态和 Session 隔离复制 Markdown 上下文
    假如 用户已在隔离桌面配置上下文复制用的确定性 Agent
    并且 用户创建了含富 Markdown 的两轮可区分主 Session 历史
    当 用户从首条用户消息的分叉菜单复制 Markdown 上下文
    那么 剪贴板只包含该用户消息，不包含之后的 Agent 或用户历史
    当 用户从首条 Agent 回复的分叉菜单复制 Markdown 上下文
    那么 剪贴板包含该回复及此前富 Markdown，排除之后历史且没有原生分叉目标
    当 用户重新载入上下文复制主 Session 界面
    那么 主 Session 历史和按 Agent 回复的上下文复制仍然成立
    当 主 Session 的 Agent 通过显式 ACP 信号开始未完成的流式回复并导出完整 Markdown
    那么 剪贴板包含流式前缀和未完成响应标记
    当 确定性 ACP 收到继续主 Session 流式回复的外部信号
    那么 完成后的完整 Session 导出包含流式结尾且不再带未完成响应标记
    当 用户创建第二个 Session，开始流式回复后从界面取消
    那么 第二个 Session 的完整导出只含自身的已取消边界，并有 ACP 取消证据
    当 用户从界面永久删除两个上下文复制 Session
    那么 上下文复制 Session 已从活动列表和 Archive 中清理
