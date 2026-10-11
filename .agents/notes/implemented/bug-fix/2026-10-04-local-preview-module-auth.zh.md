# 本地预览模块鉴权

Status: implemented
Translation: current

[English](2026-10-04-local-preview-module-auth.md)

## 摘要

本地预览签发 SameSite=Lax 凭证 Cookie，Chromium 在跨站框架中会拒绝保存它。
首层资源仍可能凭带 token 的 Referer 通过鉴权，但嵌套导入丢失凭证后会返回 403。
代理现在对本地和远程预览都使用 Secure、HttpOnly、SameSite=None、Partitioned
Cookie，并为每个本地端点使用独立名称，避免并行 Session 覆盖彼此的凭证。
合成页面的 Chromium HTTP 和 file 宿主验证通过；报告中的另一个 502 和其他
控制台警告仍未验证。

## 决策与证据

Cookie 作用域不区分端口。所有临时本地监听器原本使用相同主机、路径和名称，
所以即便浏览器接受 Cookie，也会让后开的 Session 覆盖前一个的 token。
本地名称现在包含端点 ID；远程查看器绑定不同主机名，因此远程名称保持不变。
每次 HTTP 请求和 WebSocket 升级仍检查当前活动端点的精确 token。
仅有 Origin 或不含 token 的 Referer 仍不足以授权，转发到目标前仍剥离所有 Cookie。

真实 Chrome 合成验证在 `localhost` 顶层页面中嵌入 `127.0.0.1`。
SameSite=Lax 配置没有保存 Cookie，入口和嵌套模块请求均不携带它。
改用 Secure、SameSite=None 和 Partitioned 后，Chromium 接受回环 Cookie，
两个请求都携带了凭证。这依赖 Chromium 的可信回环处理，不会让任意 HTTP
来源变成安全来源，也不保证所有浏览器引擎兼容。
[Chrome 分区 Cookie 文档](https://developer.chrome.com/docs/devtools/application/cookies)
说明了按顶层站点划分的分区键。

第二项源码级验证使用真实 LocalPreviewProxyManager、合成模块服务器和
WebSocket 回显服务器。在跨站 HTTP 宿主和 file 宿主中，分别依次打开两个
Session 框架，等待模块执行和回显事件，然后从第一个框架再次请求资源。
两个框架及回访均成功；不含凭证的请求返回 403。过程不依赖 sleep、外部服务、
用户项目文件或捕获的会话文本。

现有代理测试增加共享 Cookie jar 回归、其他端点 Cookie 和匿名请求拒绝、
上游 Cookie 剥离，以及通过 Cookie 鉴权的 WebSocket 数据传输。
Cookie 属性在 HTTP 响应边界检查；Node fetch 自身不模拟浏览器 SameSite 策略。
浏览器验证是临时源码级检查，没有新增 CI 浏览器依赖，也不是打包 Electron 测试。

验证：CLI 预览的全部 109 项测试、CLI 类型检查、修改范围的 lint 和格式检查通过。
全仓库 `pnpm format` 和类型检查也通过。根目录 `pnpm check` 在
`mobile-account-settings.tsx` 和 `unified-project-selector.tsx` 的现有
`no-shadow` lint 错误处停止，尚未进入全仓库测试。文档检查报告了六个指向
未初始化 Kimi、Pi 子模块的无关链接；没有报告本次修改文档无效。未构建打包应用。

## 范围与相关决策

本次修复凭证传递，没有放宽
[Quick Tunnel 访问契约](../../../../specs/quick-tunnel-preview.zh.md)。
此前的 [Fetch Metadata 修复](2026-09-20-preview-fetch-metadata.zh.md)
处理上游 Astro 对导航元数据的拒绝，仍然必要；它不能解决嵌套导入丢失 Cookie。
Origin 映射、本地目标绑定、远程 Cookie 名称和凭证隔离均保留。

502 可能来自上游失败或代理异常，需要响应正文来区分原因。
这些鉴权合成用例没有复现报告中的 502、404 和 styleq 警告，不宣称修复了它们。
没有替换用户正在运行的桌面和 daemon 进程。
