# 桌面认证使用 Chromium 网络栈

Status: implemented
Translation: current

[English](2026-10-08-desktop-auth-chromium-transport.md)

## 摘要

在依赖系统代理或证书信任的网络中，浏览器可能完成授权，而桌面 Node fetch 无法交换授权码。
桌面 Better Auth client 现在在应用就绪后使用 Electron Chromium 网络栈，保留 cookie 钩子和取消机制。
证书失败提供检查时间、代理/防火墙和信任配置的本地化提示，而不只是要求重新打开浏览器。
合成行为测试及隔离的 Electron 探针覆盖客户端边界；真实托管登录及打包应用的系统信任/代理验收仍需另行完成。

## 决策与证据

本修改扩展[登录协调器决策](../architecture/2026-09-17-desktop-login-coordinator.zh.md)，
保留 [Better Auth 1.6 基线](2026-09-30-better-auth-1-6.zh.md)。
当前 client 默认使用 Node 全局 fetch。CLI 的代理环境变量处理不会配置主进程传输。
Electron 的 [net API](https://www.electronjs.org/docs/latest/api/net) 提供 Chromium 网络栈和系统代理/PAC 处理，
要求应用先就绪。
Chromium 的[证书验证器 FAQ](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md)
说明如何结合显式配置的本地平台信任，并不承诺与所有系统浏览器使用完全相同的默认根证书。

`auth.ts` 为现有认证 client 的全部请求注入窄 fetch 适配器。适配器等待就绪，拒绝已取消请求，
将 URL 输入转换为字符串，直接转交 Request/init/Response，不重建响应。
当前 cross-domain 插件读取 `set-better-auth-cookie`，通过既有认证存储保存，
并在省略浏览器凭据时发送 `Better-Auth-Cookie`。普通 Set-Cookie 的可见性也影响其他 cookie 钩子。
不引入传输回退、全局 dispatcher、证书覆盖或凭据格式变更。OSS 本地组合继续禁止云端认证。

协调器仅在交换阶段分类证书失败。它通过有界 cause 链识别 Node TLS 错误码，
并识别 Chromium 的 `net::ERR_CERT_*` 消息，保留有界诊断详情，绝不重试一次性授权码。
错误命名为 `exchange_certificate_failed`，因为证书过期或主机名不匹配不能证明存在拦截。
登录页已经通过 i18n 展示 IPC 错误分类，无需新增 renderer 管理的交换或展示分支。

未采用将 CLI undici dispatcher 搬到主进程的方案，因为仅处理代理不能提供 Chromium 的证书验证器。
禁用证书检查会削弱认证边界。公共客户端源码无法确定用户失败网络实际返回了哪张证书，
因此提示不诊断攻击者，也不承诺 TUN 能修复所有证书失败。

## 验证与限制

既有回调测试覆盖应用就绪、URL/Request 请求体与响应头、cookie 保存后读取认证会话、
就绪前取消、截止时间取消传输、嵌套 TLS 与 Chromium 证书分类、拒绝重放及新 attempt 清除错误。
登录页测试覆盖两种语言的新提示。所有数据为合成数据；测试使用显式 deferred 信号和假时钟，不访问网络。

隔离的 Electron 43.7.6 探针使用合成 HTTPS 协议响应验证 POST 请求体、cross-domain cookie 响应头及 AbortSignal 拒绝。
另一个回环 HTTP 探针同时验证已固定版本的 Electron 和 cross-domain 插件，包括使用临时合成加密器保存 cookie，
以及随后读取认证会话。真实 HTTP 响应以合并后的响应头暴露普通 Set-Cookie，已固定的解析器能够处理；
自定义协议响应会省略该响应头。两个探针均未使用真实账号或托管端点。
合成自签名回环 HTTPS 探针被 Electron 以 `net::ERR_CERT_AUTHORITY_INVALID` 拒绝，
并分类为 `exchange_certificate_failed`，确认传输仍拒绝不受信任的证书。

回调测试通过 26 项，双语登录页测试通过 14 项，完整 Electron 测试通过 211 项。
`pnpm format` 与 `pnpm run docs check --base origin/main` 通过，未注册 SHA 保护主题。
`NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test pnpm check` 通过。
未设置该 Node 26 环境参数时，未修改的 boot-shell 存储失败测试因实验性 Node Web Storage 干扰 jsdom 的存储 mock 而失败；
加入参数后，同一未修改测试套件的 19 项测试全部通过。本修复不包含 boot-shell 源码或测试改动。

打包后的真实托管登录、系统代理/PAC 行为和平台证书信任需在消费方云端桌面验收。
公共 OSS 构建不能执行认证后的托管请求。[所属 Spec](../../../../specs/desktop-browser-login.zh.md)
保持 draft；实现与检查不代表人类批准。
