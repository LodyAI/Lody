# 落地页应用预览被 composer 的 mention 展开拖垮

Status: implemented
Translation: current

[English](2026-09-24-landing-app-preview-mention-expansion.md)

## 摘要

公开落地页的产品展示区不再渲染：hero 下方只剩海床。#797 让 `ChatComposer`
调用 `useMentionPromptExpansion`，其 Agent Role 查找会走到
`useVisibleMachineMetas` → `useAuthenticatedConvex`。公开站点没有
`AuthenticatedConvexProvider`，composer 抛错，预览外层的 `OptionalEnhancement`
边界随即移除了整个复刻界面。现在站点侧用别名把
`@/components/mentions/mention-expansion` 替换为恒等展开，并在生产静态检查中断言预览确实挂载。

## 决策与证据

- 在 dev server（Chrome，1440×900）复现：控制台报出来自 `ChatComposer` 的
  `useAuthenticatedConvex must be used within an AuthenticatedConvexProvider`，展示区为空。
- 与现有 `use-online-machines` shim 一样在站点边界替换，而不是让产品 hook
  容忍缺失的 provider：应用内“mention 展开运行在已认证 provider 中”的契约保持显式；
  预览从不发送 prompt，展开本就无事可做。
- `CombinedMentionTextarea` shim 同时吞掉 composer 新增的 props（`currentSessionId`、
  `draftKey`、`mentionActionsRef` 等），React 之前把它们当作未知 DOM 属性告警。
- `scripts/verify-static-browser.mjs` 为 `/` 和 `/zh` 新增 `landing app preview mounts`。
  去掉别名重新构建后两项都会超时；保留别名则通过。

## 验证与局限

`pnpm --filter @lody/site-docs build` 后运行 `test:static` 的 `STATIC_TEST_PHASE=faults`，
32 个用例通过。dev server 上仍会出现一次 three.js `compileAsync` 的 `isReady` 页面错误
（`underwater-background.tsx` 未改动，符合 StrictMode 双挂载的表现）；生产环境的 hydration
检查没有记录页面错误，不在本次范围内。
