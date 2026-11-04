# 可选中文本中不再弹出 iOS 链接预览

Status: implemented
Translation: current

[English](2026-10-14-ios-link-preview-sticky-open.md)

## 摘要

在 iOS 客户端里长按消息中的链接会弹出系统链接预览；选择“打开链接”并回到 Lody 后，点击屏幕任意位置都会再次在浏览器中打开该链接。原生壳保留了 WKWebView 的链接预览，而对话正文是 Lody 唯一重新启用长按 callout 的地方，其中的链接因此继承了它。现在可选中区域内的链接保持禁用 callout：长按只会选择文本，不再预览，链接只通过轻点打开。原生侧机制未在真机上复现；本修复移除了触发条件，而不是修复 WebKit 的状态。

## 原因与范围

`body.native-mobile-shell` 全局禁用 `-webkit-touch-callout`，再在输入框和 `[data-native-selection-allow]` 区域内恢复默认值，以支持原生文本选择。Markdown 消息、文件预览和附件都在这些区域里，链接是 `target="_blank"`。在这些链接上恢复 callout 也恢复了 WKWebView 的链接预览；其“打开链接”走的是与普通轻点不同的路径（WebKit 在按压位置发送合成点击）。让后续每次点击都变成该链接的卡住状态位于原生 WebView 中，不在本仓库内。

## 决策

在原生壳中，`[data-native-selection-allow] a[href]` 及其后代保持 `-webkit-touch-callout: none`。长按仍会开始文本选择，轻点仍通过现有锚点处理打开链接。代价：消息链接不再有系统的“拷贝链接”/“共享”预览菜单。

未采用的方案：在原生壳中设置 `allowsLinkPreview = false` 能从源头修复，但需要发布新壳且不在本仓库内；在 JavaScript 中拦截链接点击无济于事，因为卡住的点击仍以点击旧链接的形式到达。

## 验证

仅修改 CSS；jsdom 不计算 `-webkit-touch-callout`，因此没有自动化测试覆盖。需要在 iOS 客户端真机确认：长按消息链接不弹预览并开始选择；之后点击其他位置不会打开任何链接。
