# WebKit 分享图片清晰度

Status: implemented
Translation: current

[English](2026-10-29-webkit-share-image-sharpness.md)

## 摘要

带阴影的分享图片在 WebKit 上模糊，是因为 SnapDOM 2.24.15 先以原始尺寸将 SVG 画到中间画布，再放大输出。共享导出流程现在先在 WebKit 上按目标像素尺寸生成 SVG，再将其编码为 PNG。布局、原生分享交接和 2 倍目标倍率保持不变。Playwright WebKit 对合成卡片的对比显示，相同像素尺寸下文字更清晰；真实 iOS 相册保存尚未验证。

## 决策与验证

[原生分享交接](2026-10-07-native-share-image-save.zh.md)将捕获的 PNG 字节交给系统分享面板，无法控制目标应用的后续处理。[固定卡片](../feature/2026-09-14-chat-share-card-fixed-template.zh.md)的默认背景带有阴影。SnapDOM 的 WebKit 阴影兼容路径先使用原始尺寸画布，再进行放大；仅提高最终画布倍率无法恢复已丢失的细节。

先按输出尺寸渲染 SVG，再绘制到 PNG 画布。继续使用 SnapDOM 的 SVG 路径，保留其 WebKit 阴影兼容处理。长图沿用其 16,384 像素的边长和面积限制；SVG 退回 PNG 时明确报错，不把低分辨率结果当作高清 SVG。其他引擎保留原有 PNG 路径。该共享工具也用于用量卡片，因此两种分享图片在 WebKit 上都会使用此修复。

[WebKit 浏览器回归测试](../../../../packages/components/tests/e2e/interface-typography.spec.ts)检查实际 PNG 尺寸，将文字细节与缩小后再放大的副本比较，并检查移除阴影后的变化。独立 Playwright 对比使用锁定版本的 SnapDOM 和真实导出工具，卡片为合成测试数据；它没有覆盖原生分享面板、完整产品组件或实体 iPhone。
