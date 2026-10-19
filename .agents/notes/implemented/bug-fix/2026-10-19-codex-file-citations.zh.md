# Codex 文件引用卡片

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1706

[English](2026-10-19-codex-file-citations.md)

## 摘要

Codex 输出文件指令此前会在会话 Markdown 中直接显示原始语法。
渲染器现在把正文中的完整引用转换成现有文件卡片，通过会话原有的 Markdown 文件链接入口打开。
这不引入附件上传或额外文件系统权限。代码示例、不完整或非法引用不会变成卡片。

## 决策与证据

remark 转换在网址和路径自动链接之前执行，去掉路径首尾空白，拒绝重复路径属性与 URI 目标，
将文件名标点编码后交给现有路径解析器。Windows 盘符不按 URI 拒绝，盘符保留原文，分隔符统一为斜杠。
遍历只处理具有 children 数组的节点；给数学公式叶节点添加 `children: undefined` 会改变 mdast-to-hast 的节点分类并导致渲染崩溃。可选的产物属性不用于推断类型、大小或文件是否存在。
共享卡片布局支持 span 外框，确保段落内 HTML 有效。没有打开回调时复制原始路径，延续文件链接行为。

这扩展了[文件链接操作决策](../feature/2026-09-17-markdown-file-link-context-menu.zh.md)，
当前行为记录在[文件渲染文档](../../../../packages/components/src/components/ai-gui/session-files-rendering.md)。
使用按锁文件安装依赖的独立检出目录，Markdown 文件链接、流式渲染和文件卡片三个套件共 106 项测试全部通过，
包括既有行内/块级数学公式测试和新增 Windows 盘符路径测试。交付前还执行完整静态检查与 2 GiB 桌面构建验证。

PR 冒烟构建显式设置 `NODE_OPTIONS=--max-old-space-size=2048`，与既有 CLI 构建预算一致；
此前 macOS runner 使用较低的主机推导默认值，在 CLI chunk 渲染阶段内存耗尽。
静态 CI 发现的无关测试夹具重复 `now` 属性也已删除，保留其原值。
