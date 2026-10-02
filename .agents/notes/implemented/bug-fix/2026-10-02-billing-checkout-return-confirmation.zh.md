# 让 Web 订阅确认持续到权益真正落地

Status: implemented
Translation: current
PR: [#1218](https://github.com/LodyAI/Lody/pull/1218)

[English](2026-10-02-billing-checkout-return-confirmation.md)

## 摘要

从 Web 端 Stripe Checkout 成功返回后，即使已经付款，工作区仍可能显示为免费版：账单页只读一次
`?checkout=success` 标记、随即把它从 URL 中删掉，并且只调用一次
`reconcileWorkspaceCheckout`。只要这次调用短暂落空（Stripe 会话或服务端待处理记录还没关联好），
激活状态就会结束并回退到缓存里的付款前概览。现在确认过程会按标签页保存一次意图，在有界窗口内轮询
幂等的 reconcile，并在响应式权益落地前始终显示"正在激活 Plus"。这不是真实 Stripe 的验收，它消除的是
客户端一次性竞态，仍然依赖现有的服务端 reconcile 契约。

## 决定与范围

- `?checkout=success` 查询标记仍只是触发器，不是持久状态。成功返回时页面把
  `lody:billing-checkout-return:<workspaceId>` 写入 `sessionStorage`，因此刷新、路由重挂载或桌面
  deep-link 交接后仍能确认同一笔 Checkout。
- 暂时落空（`status: 'none'`）不再清除激活状态。循环每 3 秒重试一次，并在 `paid`、`expired`、
  响应式 `isBillingActivationSettled` 成立，或超过两分钟窗口时停止。超时会清掉横幅，而不是让一个被
  放弃的 Checkout 永远挂着；之后 webhook 若到达，响应式查询仍会翻转。
- `paid` 停止轮询，但有意保留激活横幅，直到概览真正翻转，避免在 reconcile 写入与订阅读取之间闪现免费版。
- `paymentProcessing` 为真时隐藏升级卡片和免费版的会话/成员上限；计划名显示 Plus，配合现有的
  "已收到付款"横幅。返回标记为 `canceled` 或未知值时会清除已保存的意图；只有标记缺失时才回退到
  已保存意图，因此被取消的 Checkout 不会借用过期的成功意图。
- `reconcileWorkspaceCheckout` 用 ref 持有：`useCloudAction` 可能每次渲染都返回新的函数标识，
  否则之前的一次性 effect 会不断重启。

## 考虑过的替代方案

- **由客户端在 `successUrl`/`cancelUrl` 里附带回调标记。** 服务端拥有桌面/Web 的返回 URL，
  也可能已经在追加该标记；在不知道契约的情况下重复追加会生成畸形或重复的查询参数。客户端保存意图
  不依赖由哪一侧追加，因此更安全。
- **保留一次 reconcile，只是不在 `none` 时清除。** 没有重试和截止时间，可能让被放弃的 Checkout
  一直停在激活横幅上；有界循环补上了缺失的另一半。
- **只等 webhook。** 这正是 reconcile 兜底要覆盖的失败；用户报告的症状就是页面过早相信了 webhook 的结果。

## 证据与限制

确定性测试覆盖了持久化标记的有效期、结算判定、激活中的 Plus 展示、"第一次 reconcile 返回 `none`、
重试后返回 `paid`"的容器流程，以及取消返回必须清除已保存意图且不触发 reconcile。组件类型检查、
Oxlint、完整的 `@lody/components` 测试套件（553 个文件）和 Oxfmt 均通过；更广的检查记录在变更交接中。
没有跑真实 Stripe，因此真实 webhook 与真实 `checkout.session.completed` 的时序仍未测量，两分钟窗口是
产品选择而非 Stripe 保证。桌面端的外部 Checkout 继续使用原有的、更长的轮询循环。
