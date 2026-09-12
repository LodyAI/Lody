# 在链接预览中公开会话标题

Status: implemented
Translation: current

[English](2026-09-11-session-share-public-preview.md)

## 摘要

社交链接预览读不到访问 fragment，因此标题必须拥有独立于会话访问权限的显式公开边界。分享
对话框现在说明链接预览会公开展示会话标题，并且不增加确认步骤。预览渲染与生命周期约束由
宿主拥有；公开阅读端读取会话与附件时仍需其 bearer。外部服务在撤销之后仍可能保留已抓取的
预览。

## 决策与证据

本记录扩展了[实时分享](2026-09-09-session-sharing.md)，并保持
[对话框布局](2026-09-09-session-share-dialog-and-reader-layout.md)不变。
[Spec 草案](../../../../specs/session-sharing.md)描述了这条仅限标题的例外。该提示同时具备
中英文案，并与既有的告知文案并列；共享 DTO 与阅读端授权行为均无变化。

宿主提供初始元数据与图片。它绝不能为了迎合社交爬虫而把访问密钥放入 URL 或公开投影。重置
会保留 share ID，因此一个不带 fragment 的旧页面会展示当前的公开标题，而旧凭据与旧图片版本
均已失效。托管环境的验收不在本仓库范围内。审阅：
[PR #539](https://github.com/LodyAI/Lody/pull/539)。
