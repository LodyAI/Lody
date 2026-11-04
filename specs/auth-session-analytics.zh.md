# 认证活跃与会话操作埋点

Status: draft
Translation: current

[English](auth-session-analytics.md)

## 场景与归属

启用遥测的宿主进入已认证工作区时，应记录一个统一活跃事件。会话控件保留有用结果，
避免把每次请求又计为一次独立使用行为。[平台约束](../packages/platform/AGENTS.md)
继续强制关闭 OSS 本地遥测；本规范不启用任何客户端或传输。

## 事件约定

- 认证就绪发送 `app/active`，保留 `active_context: authenticated_app`、身份、
  工作区、操作系统、`auth_route_ready_ms` 和启动性能属性。删除 `app/auth_ready`
  和重复的 `onboarding/account_ready`；
  发布前，消费者迁移到历史 `onboarding/account_ready` 与固定切换时间之后、按
  `active_context: authenticated_app` 过滤的 `app/active` 的并集。保留首次发生历史、
  cohort 窗口、转换窗口和内部用户过滤；保存前对比历史结果。
  CLI 的 `app/active` 和后续的 `onboarding/cli_ready` 就绪变化保持不变。
- 删除 `session/stop_requested`；保留 `session/` 下的 `stop_blocked`、
  `stop_request_succeeded` 和 `stop_request_failed`。成功仅表示请求 helper 正常返回，
  通常发生在取消指针写入后；已删除会话可能不写入直接返回。它不确认 RPC 送达或 turn
  已停止。两种完成结果都携带 helper 的 `duration_ms`，并非 agent 停止耗时。
- 删除 `session/queue_item_reorder_requested`；保留 `session/` 下的
  `queue_item_reordered`、`queue_item_reorder_failed`，并携带 helper 的 `duration_ms`。
  现有成功事件包含相同条目、条目已不存在等无操作返回，不保证顺序改变或远端同步完成。
- 删除详情菜单的 `session/search_open_requested`。保留会话内带打开状态判断的
  `session/search_opened` 及现有关闭、结果事件。它记录 handler 打开本地搜索的动作，
  不是渲染确认；现有 `source: conversation` 不区分菜单和快捷键。

成功与失败之和只能描述已经完成的 helper 尝试，不再提供独立请求分母，也无法识别进程
退出导致的中断请求。阻塞仍单独记录。历史 100% 成功不能证明操作不会失败。
本次不新增实际 turn 停止结果。

## 证据与限制

公开实现归属：`packages/components/src/routes/$workspaceName/_auth.tsx`，同一源码根下的
`components/sessions/session-chat-interface.tsx`、`session-detail.tsx`、
`hooks/use-session-actions.ts` 和 `use-session-doc.ts`。
CLI 活跃事件位于 `apps/cli/src/commands/analytics-events.ts`。
托管仪表盘与 cohort 配置在此公开仓库之外维护。客户端测试只验证事件发送与抑制，
不能证明托管配置已迁移或客户端已发布；发布前分别验证。
