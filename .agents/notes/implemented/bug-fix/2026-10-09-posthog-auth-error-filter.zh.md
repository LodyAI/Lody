# 在 PostHog 接收前过滤预期认证异常

Status: implemented
Translation: current

[English](2026-10-09-posthog-auth-error-filter.md)

## 摘要

即使部分调用方已经处理认证恢复，预期的 Convex 认证失败仍可能淹没 PostHog
Error Tracking。共享 PostHog 的 `before_send` 现在过滤符合
`lody.auth` / `unauthenticated` 结构化契约的异常事件，包含嵌套的 Convex 消息。
其他异常和混合异常链仍然上报。此变更只影响客户端上报，服务端鉴权和认证恢复保持
原样；已经部署的旧客户端仍可能继续上报这类事件。

## 决策与验证

共享 provider 覆盖自动捕获和显式 `captureException`。PostHog 序列化后不再保留
原始 Convex 错误身份，因此过滤器解析异常消息中的 JSON，并复用
`isConvexAuthErrorData`。仅包含“unauthenticated”文字的消息、其他命名空间或错误码、
损坏的载荷和普通分析事件不会被过滤。异常列表中的每一项都匹配时才丢弃事件。
保留服务端守卫可以维持鉴权；只在个别调用方过滤则会遗漏其他捕获路径。

现有 provider 测试直接调用 `before_send`，覆盖序列化的 `ConvexError`、嵌套的
action/query 消息、混合异常链及无关事件。本地测试不能证明生产环境已经停止接收；
客户端收到更新后的代码才会生效。
