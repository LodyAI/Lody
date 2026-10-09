# 删除认证与会话操作的冗余请求事件

Status: implemented
Translation: current

[English](2026-10-09-auth-session-analytics.md)

## 摘要

认证就绪连续发送两个属性相同的事件，会话控件也同时记录请求意图与后续 handler 结果。
本次保留跨端统一活跃指标和会话结果，删除四个冗余请求或就绪事件。失败和阻塞事件继续
保留，停止与排序结果增加 helper 耗时。代码路径上的发送事件减少，但未测量生产事件量
或可靠性改善。

## 决策与证据

[PR #1360](https://github.com/LodyAI/Lody/pull/1360)：[草案规范](../../../../specs/auth-session-analytics.zh.md) 负责事件映射与迁移限制。
本次延续[功能使用埋点记录](../feature/2026-09-24-new-feature-usage-analytics.md) 的
结果优先方向，不改动其无关事件清单。

`_auth.tsx` 向 `capturePostHogActiveUser` 和 `app/auth_ready` 传入相同对象；
保留前者，因为 CLI 也使用 `app/active`。详情菜单委托会话打开搜索，会话已在打开状态
判断后发送 `search_opened`，因此仅删除菜单的请求事件。
停止与排序的异常处理和界面反馈保持不变。停止 helper 不等待 RPC，仅等待取消指针
写入；会话已删除时直接返回。排序在相同或缺失条目时也会在写入前返回。
两种成功事件都不能解释成更强的分布式操作结果。

保留请求事件能够提供独立尝试分母，包括永不完成的请求；本次选择减少事件，接受失去
该能力。没有根据汇总的 100% 成功率删除失败事件，因为运行时不可用、存储及异步操作
仍可能失败。本记录不确认生产事故、采集重复率或仪表盘迁移完成。

## 验证

变更仅涉及 capture 调用和结果计时，控制流程与平台组装不变。现有搜索、机器 RPC、
PostHog analytics/provider 和 deferred PostHog 套件通过（5 个文件、80 项测试）。
路由重新生成后无差异；格式化与公开边界检查通过。全仓 `pnpm check` 的类型检查和 lint 通过，但在未修改的 CLI 递归 SSH
夹具测试处报 `context_unreadable`，单独运行该文件也能复现；
不新增仅检查 capture 调用或源码字符串的测试。
