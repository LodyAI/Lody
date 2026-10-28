# 预览应用 Cookie

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2016

[English](2026-10-28-preview-app-cookies.md)

## 摘要

应用会话需要 Cookie 来加载资源和升级 WebSocket。预览代理在本地按 Session 与目标 origin、在远程按端点区分应用 Cookie，不转发端点凭证。本地查看器主机名隔离 Chromium 的 Cookie 配额；应用设置 Cookie 时代理在最后重新下发凭证。代理强制使用分区跨站属性，使嵌入查看器能够携带 Cookie。这削弱了 SameSite 对 CSRF 的防护，也改变了应用脚本看到的名称。

## 决策与替代方案

本地名称使用 `lody_app_<scope>_<name>`，scope 是 Session ID 和目标 origin 的截断 SHA-256 哈希；远程名称使用端点 ID。代理转发给目标时还原原名。本地端点重建时复用 Cookie 名称，但重新生成凭证值；不同 Session 和目标 origin 不共享名称。每个本地 scope 使用稳定的 `lody-<scope>.localhost` 查看器主机名，代理仍只监听 127.0.0.1。Chromium 将这些名称解析到回环地址，并将它们视为不同嵌入站点。每个嵌入站点和顶层分区的分区 Cookie 配额约为 10 KiB；配额不足时应用可能丢失 Cookie。应用通过 Set-Cookie 写入时在最后重新下发凭证，在已测试的响应流程中可保护凭证；这不涵盖 JavaScript 直接写入，也不保证其他浏览器行为一致。本地解析器的 1 MiB 请求头上限为较大的客户端 Cookie 头提供边界，不是 Chromium 的 Cookie 配额。代理移除 Domain，强制 Secure、SameSite=None 和 Partitioned，保留 Path、过期属性和 HttpOnly。浏览器负责执行调整后的作用域和过期规则。[本地凭证决策](2026-10-04-local-preview-module-auth.zh.md)仍然有效。

服务端 Cookie 罐会让同一端点的观看者共享会话，在端点重建后丢失状态，还要求代理重新实现浏览器的路径和过期规则。为每个应用单独增加网关或受信代理模式只能解决单个应用，并增加进程。

端点凭证仍然必须通过校验，外来 Origin 也会保留，但两者都不能替代应用的 CSRF 防护。仅依赖 SameSite 的应用需要额外检查。浏览器中通过 JavaScript 直接读写的 Cookie 仍使用前缀名称，因此这不保证完整 Cookie 或 OAuth 透明兼容。不同浏览器对分区 Cookie 和 localhost 子域的支持也不同。测试机的 Node 系统解析器不能解析这些浏览器查看器名称；目标传输仍单独绑定到已批准的回环字面地址。

## 验证

[代理边界测试](../../../../apps/cli/src/preview/local-preview-proxy.test.ts)覆盖 HTTP、WebSocket、端点隔离和响应属性。合成 Chromium 夹具在 HTTP 和 file 顶层页面下使用真实代理和桌面 CSP：连续写入四个 3.5 KiB 应用 Cookie 后，两个预览没有 Referer token 的资源请求都成功；旧代理在同一夹具下返回 403。打包 Electron 和真实 Quick Tunnel 仍未验证。
