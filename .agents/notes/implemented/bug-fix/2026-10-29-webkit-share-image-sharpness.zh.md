# WebKit 分享图片清晰度

Status: implemented
Translation: current

[English](2026-10-29-webkit-share-image-sharpness.md)

## 摘要

SnapDOM 2.24.15 在 WebKit 上先按原始尺寸栅格化带阴影的分享图再放大，导致文字模糊。共享导出流程以目标分辨率渲染经过阴影处理的 SVG，同时让 viewBox 与输出尺寸一致，并用 `zoom` 缩放 HTML：否则 WebKit 会以错误的位置和尺寸绘制放大的 `foreignObject` 内的定位元素。浏览器测试覆盖布局、阴影和文字清晰度；通过 iOS 相册保存尚未验证。

## 决策与验证

[原生分享交接](2026-10-07-native-share-image-save.zh.md)将 PNG 字节交给系统分享面板，不控制目标应用的后续处理。[固定卡片](../feature/2026-09-14-chat-share-card-fixed-template.zh.md)的默认背景带有阴影。SnapDOM 的 WebKit 阴影兼容路径先按原始尺寸栅格化再放大，因此仅提高最终画布倍率无法恢复文字细节。

导出保留 SnapDOM 处理过阴影的 SVG，让 SVG viewBox 匹配输出像素尺寸，并按输出倍率缩放 `foreignObject` 的边界和 HTML 包装元素。否则 WebKit 会丢失定位元素的 SVG 缩放（[WebKit bug 23113](https://bugs.webkit.org/show_bug.cgi?id=23113)），导致卡片在背景上缩小约一半。该共享工具也用于用量卡片。其他引擎保留 PNG 路径；长图仍遵守 16,384 像素的边长和面积限制，SVG 退回 PNG 时明确报错。

[WebKit 浏览器回归测试](../../../../packages/components/tests/e2e/interface-typography.spec.ts)检查有无预览缩放时的 PNG 布局、阴影像素和文字清晰度。测试使用合成卡片，未覆盖原生分享面板或实体 iPhone。
