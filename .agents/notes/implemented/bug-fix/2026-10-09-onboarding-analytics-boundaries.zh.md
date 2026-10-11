# 将日常聊天状态与 onboarding 埋点分开

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1361

[English](2026-10-09-onboarding-analytics-boundaries.md)

## 摘要

普通 Chat Landing 在恢复状态及切换选择时发送 onboarding 项目和 Agent 事件，污染了引导漏斗语义。
移除这三个监听，不改名后继续产生新的日常流量。保留尝试开始、导航成功、持久完成三个阶段，
增加尝试关联，以及持久完成和持久化失败的耗时。源码足以确认边界缺陷，但缺少生产原始证据，
不能据此断言它对汇总次数的贡献。

## 决策与证据

`useFireOnKeyChange` 仅比较上一次选择键，不判断 onboarding，也不区分恢复默认值与用户操作。
项目来源监听的去重范围是组件挂载期间的 key，并非每次引导 flow。这三个监听都在普通
Chat Landing 中，桌面引导拥有独立 screens 和 flow provider。直接删除可避免给不负责引导的
页面虚构 onboarding 标记；现有 chat 和 session 事件保持不变。

`enterDesktopProduct` 独立启动持久化与导航。导航成功时持久化可能仍等待或失败；
持久化成功后导航也可能失败。因此三个阶段不是重复事件，保留它们，并在
[Spec](../../../../specs/onboarding-analytics.zh.md) 中明确持久完成漏斗分子。
尝试编号仅覆盖一次路由挂载，不是全局编号；重载可能沿用 flow id 但重新计数。

审查还发现 workspace auth 路由中的历史 `account_ready` 和 `cli_ready`，它们属于另一条
独立 auth/app 工作线，本次不修改。[Blueprint 提案](../../proposed/feature/2026-09-26-blueprint-onboarding.zh.md)
不是生产引导，不替代本次契约。

## 验证与限制

完成流程测试用产品进入及恢复状态替代仅检查 mock 次数的断言，覆盖两种完成顺序、IPC 不可用、
同步抛错、拒绝、否定写入结果、迟到失败与导航重试。路由测试验证并发触发合并、重试编号以及
进入产品、持久完成、写入失败的独立耗时。已有 analytics 测试覆盖 local 遥测门控和 flow identity。实际执行结果与环境限制见 PR。不提交捕获的用户内容或生产事件明细，不宣称已测得
流量下降，也不启用遥测 capability 或 cloud composition。

实际执行：16 项定向 onboarding 测试、全仓库 typecheck/lint、`pnpm check:quick`、
`pnpm format`、路由生成和 `pnpm run docs check` 通过。`pnpm check` 停在未修改的 CLI
递归 SSH 克隆测试，错误为 `context_unreadable`；单独重跑复现（5 通过、1 失败）。
不宣称剩余全量检查通过；未运行 Electron E2E。
