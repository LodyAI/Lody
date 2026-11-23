# 账单漏斗埋点

Status: implemented
Translation: current

[English](2026-10-18-billing-analytics.md) | 中文

## 摘要

账单设置缺少从页面进入到收银台的漏斗。共享容器现在通过现有 PostHog 清洗入口记录访问、
收银台跳转和返回、Portal 操作、周期变更及兑换。支付结果仍由托管后端负责，
浏览器返回或赠送权益激活不能证明扣款。埋点尽力发送，本地构建继续沿用能力开关。

## 决策与边界

低频 `billing/*` 事件不采样。`page_viewed` 按每次挂载的认证会话和工作区记录，
实时查询更新和 StrictMode 重放不重复记录。`checkout_started` 在升级请求前记录，
`checkout_redirected` 在 URL 交接前记录，`checkout_failed` 表示入口打开失败。
`checkout_returned` 仅记录 success/canceled 导航标记。兑换跳转使用
`source=promotion_code`，普通升级使用 `source=upgrade`。
Portal 记录打开和失败；周期变更与兑换使用一个带 outcome 的结果事件。
移除辅助操作的发起事件和周期选择事件，兑换结果不记录兑换码。
客户端不根据套餐变化、轮询或返回 URL 上报支付成功。

属性限于工作区 ID、所选周期和白名单失败分类；排除 URL、兑换码和原始异常。
复用 PostHog 清洗和平台能力开关。公共包不改变账单 API、权益或持久化结构，
服务端账单结果埋点属于独立托管后端职责。

## 验证

现有收银台确认测试覆盖返回标记和实时激活，并验证 StrictMode 访问去重以及
成功、取消返回均不发出支付结果。本地检查不能证明生产 PostHog 投递成功。
