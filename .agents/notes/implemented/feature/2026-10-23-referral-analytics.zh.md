# 推荐漏斗与奖励金埋点

Status: implemented
Translation: current

[English](2026-10-23-referral-analytics.md)

## 摘要

推荐奖励需要可观察的获客和使用节点，同时不能让埋点失败中断账单或登录。共享客户端通过现有
PostHog 通道记录首次观察到的推荐信息、可见推荐卡片、复制和分享成功及详情打开。所有调用受平台
遥测能力控制，不发送推荐链接或原始推荐码。浏览器事件记录交互，归因、付款和奖励金账目仍由托管
服务权威确认。事件尽力投递，不能替代财务账本。

推荐来源规则已于 2026-10-24 被[最后点击归因](2026-10-24-referral-last-touch.zh.md)部分替代；下文的首次触达规则保留为历史决策。

## 决策

`referral-attribution.ts` 中的推荐信息继续采用首次触达、30 天有效规则。新增的
`analyticsCapturedAt` 字段只记录应用观察到有效推荐信息后的一次埋点尝试，不修改推荐码或有效期。
静态落地页跳转已经共享这份信息，因此无需引入另一套归因存储或静态页面分析 SDK。只访问静态页后
离开的用户，以及延迟发送队列丢失的事件，不在此指标范围；已有的未标记推荐信息可能在下次启动时
被记录。事件名为 `referral/landed`，带 `source=stored_attribution`，不代表全部点击或独立用户数。

PostHog provider 仅在平台遥测能力和项目配置均存在时观察推荐信息。账单卡片加载且可见后，在每次
workspace 访问中发送一次 `referral/viewed`；打开详情发送 `referral/details_viewed`；剪贴板成功后
发送 `referral/link_copied`；原生分享完成后发送 `referral/link_shared`。分享不代表对方已经访问。
推荐码使用现有分析哈希关联交互，不上传原码、URL 或原始错误。事件低频、不采样。捕获异常被隔离，
不影响复制成功状态，也不丢弃推荐信息。

不新增云端协议或金额计算。本地产品继续禁用遥测。
[推荐界面职责](2026-10-14-workspace-referral-view.zh.md)和
[统一奖励金](2026-10-18-uniform-referral-credit.zh.md)的产品约定保持不变。

## 验证与限制

行为测试覆盖静态落地页格式的推荐信息、过期、无客户端、遥测异常、StrictMode 和重渲染去重、
workspace 切换、复制成功和失败、隐私字段及关闭遥测。这些测试不证明生产 PostHog 接收成功或真实
付款流程通过。本改动追加到 [PR #1812](https://github.com/LodyAI/Lody/pull/1812)。
