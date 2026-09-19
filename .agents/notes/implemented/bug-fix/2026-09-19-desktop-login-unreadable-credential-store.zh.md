# 不可读的桌面凭据存储阻塞浏览器登录

Status: implemented
Translation: current

[English](2026-09-19-desktop-login-unreadable-credential-store.md)

## 摘要

一位 Windows 用户在浏览器完成授权并回到桌面端后，只看到“无法完成登录”，此后每次重试都以同样方式失败，直到手动删除
`%APPDATA%\Lody\config.json`。现在该文件中当前系统密钥无法解密的凭据会被自动备份并丢弃；安全存储不可用时在打开浏览器前失败；
每次登录失败都附带不含凭据的详情，登录页展示该详情，主进程记录并上报。

## 诊断

`@better-auth/electron` 1.5.5 使用 `safeStorage` 加密会话 cookie jar，存为 `userData/config.json` 中的 `better-auth.cookie`。
其 fetch 插件的 `init` 在*每个*请求之前都会解密该值（包括无需认证的 `/electron/token` 交换），且不捕获异常。Windows 上
`safeStorage` 使用保存在 profile `Local State` 文件中、由 DPAPI 保护的密钥；当该密钥变化时（`Local State` 被重写或丢失、
profile 迁移到另一台机器或账号），每次 `decryptString` 都会抛错。于是交换在发出任何请求前就在本地失败（一次性授权码未被消耗）；
`DesktopLogin` 的 catch 丢弃了错误并发布 `exchange_failed`。重新发起浏览器登录会以完全相同的方式失败，只有删除该文件才能恢复，
这与用户的 workaround 吻合。受影响机器上的网络、TLS、时钟及深链接注册均已排除。据反馈，该机器刚从备份还原，并换了新的 Windows 账号或密码；
DPAPI 主密钥与用户 SID 及凭据绑定，因此这很可能就是诱因：旧密文随还原保留了下来，密钥却没有。这一点来自用户反馈，未经复现。
如果问题再次出现，新的详情会显示 `Error: Error while decrypting the ciphertext...`。

损坏（无法解析）的 `config.json` 会在加载 `main/auth.ts` 模块时由 `Conf` 构造函数抛错，导致主进程在打开任何窗口前就终止。

## 决策

- `main/auth-storage.ts` 包装 Better Auth 使用的 Conf 存储。读取 `better-auth.cookie` 或 `better-auth.local_cache` 时校验密文
  能否解密；不能则把 `config.json` 复制为 `config.json.unreadable-<ts>.bak`，删除该键并返回 `null`，请求随之不带 cookie 继续，
  交换会写入新的 cookie。应用尚未就绪或加密不可用时保留原值，因为此时的失败不能证明密文已丢失。已验证的密文按值缓存，
  避免每个请求都解密。
- 无法解析的存储文件在启动时改名移到一旁，并重新打开为空存储。
- 未采用“删除整个文件”作为自动兜底：该文件还保存跨域明文键，而按键删除不会丢失任何可读内容。
- `DesktopLogin` 通过 `describeDesktopLoginFailure` 概括失败：服务端 4xx 归为 `exchange_rejected`，附 HTTP 状态、
  Better Auth 错误码与消息；其他失败保持原分类，附错误名、消息与系统错误码。依赖可抛出带特定分类的 `DesktopLoginFailure`，
  例如打开浏览器前的 `secure_storage_unavailable`。详情作为 `ElectronLoginState.errorDetail` 传递，在登录页本地化消息下方以
  可选中文本展示；`AuthService` 记录日志，并通过现有主进程 PostHog 客户端上报（仅云端构建）。从不读取请求体、请求头或回调载荷。

## 验证

`auth-storage.test.mjs` 使用真实 Conf 文件和合成 cipher：外来密钥加密的密文被逐字节备份并持久删除，重新写入后不再被标记；
跨域明文不受影响；应用就绪前或加密不可用时不丢弃任何值；截断的 JSON 存储被移到一旁并重新打开为空。回调测试现在经 Better Auth
客户端驱动真实的内存 Better Auth 1.5.5 服务器：未知授权码得到 `exchange_rejected` 与 `HTTP 4xx INVALID_TOKEN ...`，
详情中不含授权码或 state；同时覆盖传输失败的系统错误码及打开浏览器前的安全存储失败。

这些测试未覆盖打包后的 Windows DPAPI 行为及托管交换。
