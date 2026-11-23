# 预览导航的 Fetch Metadata

Status: implemented
Translation: current

[English](2026-09-20-preview-fetch-metadata.md)

## 摘要

Astro 开发页面在外部浏览器中正常，却可能在托管预览中显示纯文本 403。
Node fetch 将导航模式改写为 `cors`，却保留浏览器的跨站元数据，把原本允许的
导航变成了看似跨站的资源请求。共享预览 HTTP 请求头构造函数现在仅对导航请求
移除浏览器 Fetch Metadata。Origin 和资源请求的元数据保持不变，无需关闭项目安全配置。

## 决策与证据

本地代理和远程隧道都在请求绑定的 loopback 目标前调用
`buildLocalPreviewRequestHeaders`。修复在此处理 `navigate` 和 `nested-navigate`，
移除服务端转发这一跳的 Site、Mode、Dest、User 元数据；Node 仍会生成自己的 Mode。
直接转发原始 Mode 无法阻止 fetch 改写，而对所有请求移除元数据会不必要地丢弃
跨站资源校验信息。

[Astro 中间件](https://github.com/withastro/astro/blob/main/packages/astro/src/vite-plugin-astro-server/sec-fetch.ts)
允许没有 Site 元数据的请求和导航，对跨站资源请求则返回
`Cross-origin request blocked`。原有预览凭证校验和目标绑定仍在访问上游前执行。

回归测试通过 Node HTTP 请求而非 fetch 构造浏览器导航头，经过真实本地代理访问
采用 Astro 同类校验的服务。覆盖两种导航模式、`cors`/`no-cors` 跨站资源拒绝，
以及缺少预览凭证时在访问上游前拒绝请求。这是本地 HTTP 测试，尚未验证反馈用户
安装的 Astro 版本或打包后的 Electron 应用。
