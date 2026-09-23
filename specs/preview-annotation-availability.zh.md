# 预览标注可用性

Status: draft
Translation: current

[English](preview-annotation-availability.md)

用户打开托管预览时，即使可选的标注运行时缺失、被拦截或延迟，也能查看和操作
网页。标注不可用不得遮盖内容、报告页面加载失败或阻止刷新。真实的网络、授权
和代理故障仍然是故障。

iframe 负责文档加载状态。运行时消息用于启用标注和报告导航信息，也可为页内
导航提供尽力而为的工具栏加载提示。原生 iframe load 独立结束加载状态；运行时
提示不决定文档就绪或内容可见性。迟到的有效握手可以直接启用标注，无须刷新网页。

运行时只接受真实父窗口的控制消息，并在当前文档内锁定首次接受的来源。
上一页的 referrer 不能证明父窗口身份。无关窗口不能建立此绑定。

CLI 独立验证代理可达性，不依赖标注注入。应用返回的错误页面仍可查看。如果
只是添加标注脚本就导致响应超过大小限制，则返回未注入的原网页；原始响应
本身超限仍然拒绝。

## 证据

- [预览界面](../packages/components/src/components/sessions/managed-preview-surface.tsx)
- [运行时](../packages/shared/src/visual-annotation-injected-script.ts)
- [代理就绪检测](../apps/cli/src/preview/preview-tunnel-readiness.ts)
