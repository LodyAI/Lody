# 2026-08-25 → 2026-09-23 新功能的使用率埋点

Status: implemented
Translation: current

[English](2026-09-24-new-feature-usage-analytics.md)

## 摘要

0.86.2 到 0.100.0 之间上线的大部分新功能没有 PostHog 使用事件，无法看到渗透率、频次和复用。
现在每个经过审阅的功能都会在动作真正成功时，由 renderer 发出一个独立的 `<domain>/<action>` 事件，
属性只包含枚举、计数和布尔值。除大纲跳转和模糊搜索选中这两个高频交互走 tier C 采样外，其余均为
tier A 全量。本地 OSS 构建没有 PostHog 客户端，因此仍然不发送任何数据。

## 决策

- **每个动作一个独立事件**，不使用统一的 `feature/used { feature }`，与现有 `session/*` 命名一致，漏斗无需属性过滤。
- **成功后才记，不记意图。** 分享、复制、导出、保存和原生调用在 promise resolve 后才捕获；取消的对话框和自动动作
  （发布后的自动复制、过期草稿清理）不计入。
- **只在 renderer 发送。** 平台契约规定 Electron main 与 CLI 遥测硬关闭；独立窗口、开机自启和文件操作都在 renderer
  发起处捕获。`openDesktopWindow` 新增显式 `source` 参数，并通过 `deferredPostHog` 发送，因为它是被 memo 化侧边栏行调用的 lib 代码。
- **不含 PII。** 文件类型由 `getAnalyticsFileKind` 归类为 `html|md|image|pdf|other`；DeepSeek 自定义服务地址只上报布尔值。

## 审阅范围与排除项

审阅后决定不埋：队列 Steer、Zen 布局、`@` 会话提及的当前/所有项目切换、DeepSeek Ask Question、公开分享页的匿名访问。
新 Agent 与新模型已由 `session/start_requested` 的 `agent_type`/`model_id` 以及 CLI `acp/*` 事件覆盖。
移动端分享面板创建任务的流程在公开和私有源码中都没有找到，因此暂未埋点。

## 事件清单

事件表与英文版相同，见 [English](2026-09-24-new-feature-usage-analytics.md#event-inventory)。

## 验证与限制

`@lody/components` 的 `tsgo --noEmit` 通过；分享管理、容量自动重试、Role 选择、模型搜索和文件操作的现有测试通过。
没有新增测试，因为只断言 mock 捕获调用的测试无法发现用户行为回归。应用图标事件在共享该组件的 macOS Electron 上也会触发。
`is_subagent` 的含义是"计划显示在子会话中"，因为计划本身没有子 Agent 身份。
