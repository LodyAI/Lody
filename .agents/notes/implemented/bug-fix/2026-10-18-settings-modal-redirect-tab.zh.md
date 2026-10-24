# 桌面设置弹窗在重定向期间保持 URL 指定的标签页

Status: implemented
Translation: current
PR: [#1696](https://github.com/LodyAI/Lody/pull/1696)

[English](2026-10-18-settings-modal-redirect-tab.md)

## 摘要

订阅成功后，用户会回到 `/<slug>/settings/billing?checkout=success`，但桌面设置弹窗打开的是
Account 而不是 Billing。在桌面宽度（Web 与 Electron）下，设置路由只是跳板：它按 URL 中的标签页打开
弹窗，再把 URL 替换为来源页面或 chat。重定向尚未完成时，TanStack Router 已经把目标地址报告给仍然挂载的
设置布局，导致其 effect 在没有标签页的情况下再次执行：把弹窗重置为默认标签页、清空机器/项目目标，并在
丢失 `from` 的情况下再次重定向。现在该 effect 只在地址仍为设置路径时执行。付款、回跳 URL 与结账确认
逻辑均未改变。

## 证据

- `router-core` 在 matches 切换之前，就以 `status: 'pending'` 把 `location` 设为新地址，因此即将卸载的
  布局中 `useLocation()` 会有一次渲染返回 `/<slug>/chat`。`getActiveSettingsTabId` 对它返回 `null`，
  `activeTabId ?? SETTINGS_DEFAULT_TAB` 于是选中 `account`。
- 两条结账回跳路径都会到达该布局：Stripe Web 端的 `successUrl`，以及经
  `resolveDesktopCheckoutReturnDeepLinkPath` 解析的 Electron `lody://checkout-return` 深链。
  Capacitor/移动端宽度渲染设置页面，不受影响。
- 该缺陷并非账单特有：任何桌面设置深链都会丢失标签页和 `from`。

## 决策

守卫复用现有的 `isSettingsPath`。只执行一次的 ref 也能阻止重置，但会忽略布局仍挂载时真实的设置标签页
变化。Billing 标签页在挂载时仍能看到 `?checkout=success`，因此
[#1218](2026-10-02-billing-checkout-return-confirmation.zh.md) 的单标签页确认流程照常启动。

## 验证与限制

`tests/settings-layout-desktop-redirect.test.tsx` 在使用浏览器历史的真实路由下挂载真实布局，覆盖结账回跳
（Billing 标签页、标签页可见回跳标记）以及 `from` 加机器目标的返回。两者在修复前均失败。未进行真实
Stripe 付款或打包版 Electron 运行。
