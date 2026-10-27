# 会话对话设计审查 Story

Status: implemented
Translation: current

[English](2026-10-27-session-conversation-design-review.md)

## 摘要

会话阅读 Story 展示了正文和文件摘要，但缺少对话 UI 重新设计所需的多种界面。它现在用合成历史组合可见的思考、工具结果和内联 diff、评论与视觉标注引用，以及 Markdown 示例。配套状态复用同一份历史，展示进行中、权限和提问、移动端布局以及带标注的预览。Story 使用生产渲染组件和模拟数据，因此不能证明真实运行时或原生设备上的行为。

## 决策

扩展现有的[会话对话 Story](../../../../packages/components/src/stories/SessionConversationPage.stories.tsx)，不另造一套视觉实现。阅读会话标识为内置 DeepSeek，因为对话渲染器会为该提供方展示思考正文。点击文件时，真实桌面 diff 面板或移动端抽屉使用合成文件提供方打开内容。标注变体使用真实托管预览组件、静态页面和内存评论存储，不模拟实时检查器或网络连接。[Story 指南](../../../docs/sessions-stories.md)负责说明入口和覆盖范围。

## 验证

在独立 checkout 中使用锁定依赖，对合成 Story 执行组件类型检查和浏览器交互检查。该 fixture 不验证完整 Session 运行时、Electron 集成、原生移动端手势或真实预览传输。
