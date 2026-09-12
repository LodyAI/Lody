# language: zh-CN

功能: 本地文本附件的跨会话生命周期

  @lody @essence @P1 @runtime-simulator @LODY-ATTACHMENT-001
  场景: 用户管理文本附件的预览、历史、持久化与会话隔离
    假如 用户已在隔离桌面配置文本附件用的确定性 Agent
    并且 用户从 New chat 创建了附件主 Session 的真实历史
    当 用户通过 composer 文件选择器取消选择本地文本附件
    那么 composer 不显示附件预览且不能发送空草稿
    当 用户通过 composer 文件选择器添加本地文本附件并带文本发送
    那么 已发送的文本附件预览和提示显示在主 Session 历史中且 composer 草稿已清理
    当 用户在同一 Session 发送后续纯文本消息
    那么 后续纯文本消息保留在历史中且不携带旧文本附件
    当 用户重新载入主 Session 界面
    那么 重载后的主 Session 保留文本附件和两条用户消息
    当 用户归档并从 Archive 恢复包含文本附件的主 Session
    那么 恢复后的主 Session 仍显示文本附件和后续纯文本历史
    当 用户创建另一个不带附件的 Session
    那么 另一个 Session 看不到主 Session 的文本附件
    当 用户永久删除主 Session
    那么 主 Session 的文本附件已清理且另一个 Session 仍可见
    当 用户永久删除另一个 Session
    那么 两个 Session 都已从活动列表和 Archive 中清理
