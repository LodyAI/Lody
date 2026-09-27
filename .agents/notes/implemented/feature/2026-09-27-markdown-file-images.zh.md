# Markdown 文件图片

Status: implemented
Translation: current

[English](2026-09-27-markdown-file-images.md)

PR: [#1042](https://github.com/LodyAI/Lody/pull/1042)

## 摘要

Markdown 文件预览原先直接把文件系统图片路径交给浏览器，无法相对文档定位图片。
现在实时文件界面向 Markdown 图片组件提供所属文件读取器和文档路径。
本机资源自动加载；远端图片保持骨架占位，点击后才读取完整内容并通过 Blob URL 展示。
现有文件权限和传输上限继续生效；没有实时文件读取器的上传附件不在本次范围内。

## 决策与证据

界面复用 `FileWorkspaceProvider.openFile`：Session 文件读取器已将本机图片路由至
Electron 资源服务，将远端图片路由至有大小限制的 File Preview v3。
没有新增 HTTP 服务、云端上传或 daemon 协议。另一种做法是自动拉取所有远端图片，
但会传输用户可能不需要的文件，并影响阅读。采用用户指定的交互，逐张点击后读取。

`resolveMarkdownImagePath` 在现有文件身份模块解析相对路径，不套用聊天链接的
行号清理或 worktree 重定位。Session 预览和移动端项目浏览使用实际返回的文档路径。
图片 effect 忽略过期请求并释放自己创建的 Blob URL；本地能力 URL 仍由 Electron 管理。
匿名展示先于文件解析器检查，不能获取文件读取能力。

意图：[本地文件链接](../../../../specs/local-file-link-actions.zh.md)。
实现：[文件图片组件](../../../../packages/components/src/components/ai-gui/markdown-file-image.tsx)。

## 验证

在已有文件路径和 Markdown 图片测试中增加相对与绝对路径、点击后才读取、本地资源
URL、失败重试、切换读取器或文档、URL 释放以及匿名发布隔离的行为覆盖。
上述测试及 Session 文件内容测试共 80 项通过。组件类型检查、翻译键检查、格式化和
定向 lint 均已执行（lint 在旧文件中有既有警告）。验证复用了本机依赖，并在独立临时
目录补齐缺失依赖；仓库依赖清单和锁文件没有变化。文档检查仍报告未初始化 ACP 子模块
造成的链接缺失，本次修改的文档没有错误。尚未执行真实 Electron 或远端网关的交互验证。
