# 预览应用 Cookie

Status: implemented
Translation: current

[English](2026-10-28-preview-app-cookies.md)

## 摘要

应用会话需要 Cookie 来加载资源和升级 WebSocket。预览代理为每个端点使用独立的 Cookie 名称，只向目标转发当前端点的应用 Cookie，不转发端点凭证。代理强制使用分区跨站属性，使嵌入查看器能够携带 Cookie。这削弱了 SameSite 对 CSRF 的防护，也改变了应用脚本看到的名称。

## 决策与替代方案

本地和远程端点都使用 `lody_app_<endpointId>_<name>`；代理转发给目标时还原原名。代理移除 Domain，强制 Secure、SameSite=None 和 Partitioned，保留 Path、过期属性和 HttpOnly。浏览器负责执行调整后的作用域和过期规则。[本地凭证决策](2026-10-04-local-preview-module-auth.zh.md)仍然有效。

服务端 Cookie 罐会让同一端点的观看者共享会话，在端点重建后丢失状态，还要求代理重新实现浏览器的路径和过期规则。为每个应用单独增加网关或受信代理模式只能解决单个应用，并增加进程。

端点凭证仍然必须通过校验，外来 Origin 也会保留，但两者都不能替代应用的 CSRF 防护。仅依赖 SameSite 的应用需要额外检查。浏览器中通过 JavaScript 直接读写的 Cookie 仍使用前缀名称，因此这不保证完整 Cookie 或 OAuth 透明兼容。不同浏览器对分区 Cookie 的支持也不同。本地端口共用 Cookie 主机：前缀可以防止意外冲突，但脚本可以读取或修改其他端点的非 HttpOnly Cookie。

## 验证

[代理边界测试](../../../../apps/cli/src/preview/local-preview-proxy.test.ts)覆盖 HTTP、WebSocket、端点隔离和响应属性。真实浏览器及 Quick Tunnel 行为需要另行验证。
