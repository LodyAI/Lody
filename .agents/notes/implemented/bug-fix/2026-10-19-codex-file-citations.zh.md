# Codex 文件引用卡片

Status: implemented
Translation: current

[English](2026-10-19-codex-file-citations.md)

## 摘要

Codex 输出文件指令此前会在会话 Markdown 中直接显示原始语法。
渲染器现在把正文中的完整引用转换成现有文件卡片，通过会话原有的 Markdown 文件链接入口打开。
这不引入附件上传或额外文件系统权限。代码示例、不完整或非法引用不会变成卡片。

## 决策与证据

remark 转换在网址和路径自动链接之前执行，去掉路径首尾空白，拒绝重复路径属性与 URI 目标，
将文件名标点编码后交给现有路径解析器。可选的产物属性不用于推断类型、大小或文件是否存在。
共享卡片布局支持 span 外框，确保段落内 HTML 有效。没有打开回调时复制原始路径，延续文件链接行为。

这扩展了[文件链接操作决策](../feature/2026-09-17-markdown-file-link-context-menu.zh.md)，
当前行为记录在[文件渲染文档](../../../../packages/components/src/components/ai-gui/session-files-rendering.md)。
使用可用依赖和隔离测试配置，Markdown 文件链接套件的 30 项测试通过，包含真实 Markdown 解析和 React 渲染。
现有依赖安装缺少 `@stylexjs/unplugin`，完整 UI 套件无法启动；已补卡片交互测试及 Storybook 状态，尚未在该环境验证。
