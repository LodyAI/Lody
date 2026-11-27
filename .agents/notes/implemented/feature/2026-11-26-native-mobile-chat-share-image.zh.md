# 原生移动端对话分享图片卡片

Status: implemented
Translation: current

[English](2026-11-26-native-mobile-chat-share-image.md)

## 摘要

原生 iOS 与 Android 客户端此前缺少类似 Web 端选择一段或多段对话并导出/复制为排版卡片 PNG 的能力，而早期混合方案依赖渲染型 WebView 对 DOM 进行截图。两端现通过共享的 `conversationShareMessages` 运行时调用读取已持久化的结构化正文轮次与题注溯源信息，并在原生 UIKit 与 Jetpack Compose 中完整实现多选模式、实时缩放预览及按水平条带分段光栅化的离屏 PNG 导出。该方案省去了渲染型 WebView 的启动开销、字体与前端包体冗余以及超长文档的 GPU 纹理上限问题，同时与 Web 固定分享卡片模板保持一致。当前卡片模板与 Web 正文投影一致，暂不在正文中内联渲染助手图片附件；个别定制 Android 系统分享面板若忽略 `IntentSender` 回调，则目标选择确认退化为尽力而为。

## 决策与备选方案

Web 端的[固定分享卡片模板](2026-09-14-chat-share-card-fixed-template.zh.md)与[调色板隔离修复](../../implemented/bug-fix/2026-10-06-chat-share-palette-isolation.zh.md)通过 SnapDOM 截取实时 DOM。对于独立的原生客户端（`apps/mobile/ios` 与 `apps/mobile/android`），复用渲染型 WebView 预览与截图的方案被否决：

- 两端均在无界面、严格 CSP 限制的数据宿主中运行 `cloud-runtime`，并未打包 React/StyleX/Shiki 及额外渲染字体。引入渲染型 WebView 需要重复维护 Markdown、语法高亮、Mermaid 与中英文等宽字体栈，且在长对话选区下容易触发 WebKit 与 Chromium 的最大纹理高度截断或内存峰值问题。
- 两端原生已具备完整的消息列表、Markdown 分块渲染、基于 Pele 的 Mermaid 矢量渲染、`@` 提及胶囊及 `<message-quote>` 引用块组件。

因此仅在 `cloud-runtime` 共享结构化协议提取，UI 与光栅化全部由各平台原生承担：

```text
当前监听会话历史 (cloud-runtime)
  -> conversationShareMessages（持久化 user/assistant 正文、解码后的提及与引用、modelName、estimatedTokens、会话元数据）
  -> 原生列表多选模式（仅限已加载窗口内的轮次集合，导出恒按历史时间正序）
  -> 原生预览半屏面板（UIKit / Compose 实时等比缩放卡片，Chat 360pt | Post 560pt、6 种背景、mat 0..96、浅色 | 深色）
  -> 离屏 <= 2048 px 水平条带光栅化（默认 @2x、总高上限 16,384 px、最低 1.25x 降档保护）
  -> 系统剪贴板 或 隔离临时缓存文件 + 系统分享面板
```

## 协议与渲染边界

- **共享运行时投影（`conversationShareMessages`）：** `packages/cloud-runtime/src/protocol/conversation-share-image.ts`（同步镜像至 `apps/mobile/android/runtime/vendor/cloud-runtime`）从当前已就绪的会话副本中筛选非排队状态的 `user` 与 `assistant` 非空正文轮次，以空行拼接多段文本，将用户消息中的 `@` 提及与 `<message-quote>` 跨度解码并重算为 UTF-16 `references`（`mention` 与 `quote`），连同隐藏推理和工具文本一起估算轮次 Token 数（与复制 Markdown 口径一致），记录每条助手消息的 `modelName` 与 `userTurnId`，并从最新消息向前限制单次传输体积不超过 6 MiB。
- **已加载窗口选区与时间序保证：** 选区状态以无序集合记录轮次 ID 并与当前 UI 已加载列表项求交，保证「全选」只作用于已加载历史，向上翻页加载更早消息后自动纳入可选集合。折叠为多行的同一助手轮次共享首个被动勾选徽标并整体联动高亮与切换；预览与导出始终按会话原始时间正序排列。配对的提问与回复（`userTurnId` 匹配上一条入选用户轮次）使用紧凑间距 `replyGap`（`12`/`14`），跨轮次非连续多选使用完整轮次间距 `exchangeGap`（`24`/`28`）。
- **卡片主题隔离与静态排版规则：** 遵循[对话图片分享规格](../../../../specs/chat-share-image.zh.md)与[跨端移动规则](../../../../apps/mobile/docs/rules/cross-platform.md)，iOS 将 `UITraitCollection`（`userInterfaceStyle` 与固定 `.large` 字号档位）限定在卡片子树，Android 将 `LodyTheme(darkTheme)` 与 `Density(fontScale = 1f)` 限定在卡片子树（深色表面采用 `#111113` / `#161618`，绝不使用纯黑 `#000000`）。用户提问框与引用快照全部展开不截断；助手代码与 diff 块强制软换行并移除横向滚动条与复制按钮；超宽表格按卡片内宽等比缩放。
- **受限条带导出与明文/E2EE 门禁：** 预览直接缩放原生卡片视图而不预先生成整幅位图。导出默认采用 `@2x` 并以 `16,384 px` 为像素高度上限，超长卡片自动降档至最低 `1.25x`，超出上限则在分配大图前直接提示减少所选消息。光栅化按 `<= 2048 px` 高的水平条带分段执行（iOS 在 CPU 位图上下文中分段绘制；Android 将单条带扫描线流式写入基于 `Deflater` 的 RGBA PNG 编码器，峰值条带位图内存保持在约 9 MiB）。选区入口、开始光栅化前以及写入剪贴板或调起系统分享面板前均复核明文工作区（`WorkspaceModePins`）与当前 `(accountId, workspaceId, sessionId)` 作用域；临时 PNG 目录（iOS `tmp/lody-chat-share/<uuid>/`、Android `cacheDir/shared-images/chat-share/<uuid>/`）在完成、取消、启动及账号切换时清理。

## 验证

- `apps/mobile/ios/apps/ios/tests/cloud/conversation-share-image.test.mjs` 与 `apps/mobile/android/runtime/test/contract-bridge.test.mjs` 覆盖正文提取、提及与引用偏移重算、含隐藏步骤的 Token 估算、模型归属与契约校验。
- iOS 单元测试 `apps/mobile/ios/packages/LodyKit/Tests/LodyKitTests/ChatShareImageTests.swift` 覆盖非连续选区正序输出、问答间距、题注元数据、宿主相反外观下的浅深色像素隔离、多条带长图 PNG 尺寸、缩放边界与临时目录清理。
- Android 单元测试 `apps/mobile/android/app/src/test/kotlin/app/lody/android/chat/ChatShareImageTest.kt` 覆盖 JSON 协议解码、分页窗口扩展、连续与非连续轮次间距、紧凑 Token 与 UTC 时间格式化、条带导出规划、`StreamingPngWriter` RGBA 像素一致性及中英文字符串键对齐。
- 忽略 `Intent.createChooser` `IntentSender` 回调的第三方定制 Android 系统分享面板仍需真机手工确认。
