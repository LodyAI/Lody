# 限时促销活动展示与协议契约

Status: implemented
Translation: current

[English](2026-11-26-promo-campaign-display.md) | 中文

## 摘要

限时 Plus 促销同时涉及新开订阅首期 Checkout、月付转年付净差额升级报价、周期内新增成员席位以及公开官网；若将活动价直接写入静态预渲染页面，活动跨界后仍会残留过期报价。`@lody/cloud-api`、`@lody/components` 与 `site-docs` 现统一消费服务端下发的促销条款，在不向客户端暴露 Stripe Coupon ID 的前提下比较首期活动与推荐折扣，并在官网水合后渐进叠加当前生效的活动横幅与价格。预渲染 HTML 保持标准目录价，客户端定时器依据服务端权威截止时间即时失效并在网络异常时使用有界指数退避重试。托管端 Stripe 结算与环境变量活动配置由私有后端仓库负责验证，不在公开前端测试范围内。

## 决策与职责

`@lody/cloud-api` 在 `Pricing` 上新增可选的 `PromoCheckoutOffer`（含可选的字符串或多语言映射活动名称 `PromoCampaignName`），在 `previewSubscriptionIntervalChange` 上新增 `promoKind`（`early_bird_forever` 或 `campaign_once`）、`promoDiscountPercent` 与 `promoName`，并在 `SeatInvitePreviewSchema` 的 `billed` 分支新增 `promoDiscountPercent`、`promoName`、`promoEndsAt`、`regularProratedAmount` 与 `policyNextChangeAt`。`getBillingOverview`、`getMyNewWorkspacePricing` 与 `getWorkspaceSeatInvitePreview` 接受可选的 `policyRefreshKey`，客户端在值为 `0` 时省略该字段，保证前后端按任意顺序滚动发布均可兼容。客户端不接收 Coupon ID，也不在本地计算升级差额折算；未配置自定义活动名称时自动回退至本地化通用文案。

创建工作区与账单页复用[推荐活动展示](2026-10-23-referral-campaign-display.zh.md)的边界刷新机制，同时追踪推荐与促销的 `nextChangeAt` 及保留 Checkout 的过期时间。首期促销优惠同样展示在赠送期结束后续订预约卡片（`canScheduleAfterGift`）上，而推荐折扣不适用于赠送续订设置。当推荐归因与首单促销在普通新订场景同时存在时，界面展示更高的买方折扣（`max(promo, referral)`，相同时保留推荐提示），并在百分比折扣生效时隐藏推荐余额抵扣预览，推荐人返现归因仍由服务端独立维护。月转年确认弹窗将单次净差额促销（`campaign_once`，明确提示下期按每席位每年 $96 标准价续费）与历史永久早鸟账户区分展示；成员邀请提示在 `promoEndsAt` 前展示当期折后按日计费金额与划线的原价按日金额。

公开官网延续[移除固定年付早鸟展示](../simplification/2026-10-01-end-yearly-early-bird.zh.md)的约束，预渲染 HTML 仅输出标准目录价（年付折合每月 $8，月付 $10）。`/price` 在挂载后、首页在首屏空闲且位于 `OptionalEnhancement` 边界内时，由 `use-public-promo.ts` 请求只读接口 `GET /api/billing/public-promo`（静态托管未同源代理 `/api/*` 时通过 `VITE_CONVEX_SITE_URL` 解析），在全部 8 种站点语言下渲染固定 `64px` 导航栏下方的窄横幅及 Plus 卡片活动价，并通过 `serverNow` 时钟偏移计算本地到期定时器，在 `endsAt` 到达瞬间自动恢复标准价而无需等待缓存重验证。

## 验证

界面与解析逻辑由 [`referral-campaign.test.tsx`](../../../../packages/components/tests/referral-campaign.test.tsx)、[`billing-interval-dialog.test.tsx`](../../../../packages/components/tests/billing-interval-dialog.test.tsx)、[`seat-cost-disclosure.test.tsx`](../../../../packages/components/tests/seat-cost-disclosure.test.tsx) 与 [`public-promo.test.ts`](../../../../site-docs/lib/public-promo.test.ts) 覆盖。托管端 Stripe Coupon 创建、Credit Note 折扣分摊、防套利付款历史校验及 Cloudflare Pages `VITE_CONVEX_SITE_URL` 注入不在公开仓库验证范围内。
