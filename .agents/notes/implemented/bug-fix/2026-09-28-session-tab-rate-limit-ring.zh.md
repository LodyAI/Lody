# 在新会话标签页显示订阅用量

Status: implemented
Translation: current

[English](2026-09-28-session-tab-rate-limit-ring.md) | 中文

## 摘要

新会话标签页在收到上下文用量前会隐藏用量环，即使机器已经提供订阅额度数据。
共享会话输入区现在启用已有的仅额度显示能力，与首页输入区一致。
收到上下文用量后仍优先显示上下文用量；缺少用量数据时仍隐藏入口。

## 决策与验证

`SessionChatInputArea` 向 `SessionUsagePopover` 传入
`showRateLimitWithoutContext`，同时覆盖草稿标签页与侧边对话，不改变弹层的默认行为或
Provider 资格检查。定向搜索未发现记录此显示条件的现有笔记。

现有 `session-usage-popover.test.tsx` 已覆盖启用仅额度显示时的入口和详情，
本次参数接线未添加重复测试。工作区缺少依赖，阻碍了本地测试、`pnpm check` 和
`pnpm format`。文档检查已有指向未初始化 ACP 子模块的失效链接；未进行应用界面验证。
