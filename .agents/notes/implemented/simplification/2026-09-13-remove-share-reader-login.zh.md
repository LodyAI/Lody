# 移除分享读取页登录入口

Status: implemented
Translation: current

[English](2026-09-13-remove-share-reader-login.md)

## 摘要

分享读取页原先在右上角向匿名访客提供登录链接，窄屏时显示为图标。
现在完整移除该入口，阅读分享时不再出现登录提示。
宿主已确认的访客身份继续显示；匿名访客不显示身份占位。

## 决策与证据

`session-share-identity.tsx` 对未登录访客返回 null，并移除应用来源参数。
页面仍将应用来源用于既有品牌链接。改动删除整个控件，而非通过响应式 CSS 隐藏文字。
所属页面测试检查登录文字及链接均不存在，并保留已登录身份的现有覆盖。
此改动不包含托管部署；当前意图见[分享规范](../../../../specs/session-sharing.zh.md)。
