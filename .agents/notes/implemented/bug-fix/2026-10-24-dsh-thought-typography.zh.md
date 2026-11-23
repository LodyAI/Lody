# DSH 思考正文样式

Status: implemented
Translation: current

[English](2026-10-24-dsh-thought-typography.md)

## 摘要

DSH 思考独立展示后仍使用灰色紧凑样式。其专用虚拟行现在复用普通回答的 Markdown
组件，统一字体、字号、字重、行距和阅读颜色。思考折叠标识、搜索身份、工具折叠及
其他 Provider 路径保持不变。

## 证据与验证

本次补充[独立展示决策](../feature/2026-10-22-dsh-independent-text-tool-display.zh.md)。
只调整 builtin DSH 使用的 `AssistantThoughtVirtualRow`，不修改共享 `ThoughtCard`
或子代理、工具的过程样式。已有 DSH Storybook 用例增加计算样式一致和工具输出隐藏的断言。

临时浏览器预览使用实际思考行、MarkdownBlock、MarkdownRenderer、StyleX token
以及合成文字。会话、搜索、文件和图表服务使用桩，工具折叠行由预览外壳提供，因此
不属于完整桌面或工具折叠集成测试。Chromium 确认两者字体相同，字号为 16px，字重
400，行距 27.4286px，颜色 rgb(33, 33, 33)。截图经过人工视觉检查，不含真实会话。
无依赖的工作树中未运行完整 Storybook play 测试和包构建。可用 CLI 的登录令牌失效，
截图上传受阻；本地图片保留在源码管理之外。
