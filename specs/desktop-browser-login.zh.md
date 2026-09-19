# 桌面浏览器登录

Status: draft
Translation: current

[English](desktop-browser-login.md)

云端桌面用户在系统浏览器授权后，回到应用必须建立登录身份，或明确说明如何发起新的登录。
仅打开窗口不代表认证成功。OSS 本地模式不得启动此流程。

## 职责与恢复

主进程管理唯一的当前浏览器登录 attempt：随机 PKCE state 和 verifier、有效期、凭据交换及带版本号的结果。
React 页面和产品窗口订阅结果，不拥有交换事务。新挂载窗口先订阅事件再查询快照，忽略旧版本。

```text
等待浏览器 -> 交换中 -> 已认证
    |          |
    +--> 失败 <-+
          |
      发起新 attempt
```

只有精确匹配的认证回调 URI 和当前 state 能交换授权码。并发回调复用同一次交换；已经完成、过期或被替代的
attempt 不得再次交换，也不得注销有效身份。新 attempt 可以替代仍在等待浏览器的 attempt；交换进行中必须先等待其结束。
主动退出会取消 attempt，并阻止迟到结果恢复身份。主进程重启会丢失内存中的 verifier，必须重新发起浏览器登录，不得绕过校验。

浏览器等待期为五分钟，交换截止时间为 25 秒。交换超时意味着服务端结果未知；界面可以查询现有会话，但不得重复兑换同一授权码。
打开浏览器失败、过期、交换失败、超时及重启分别提供本地化错误说明。服务端拒绝授权码（4xx）与传输失败、本地失败区分开；
系统安全存储不可用时在打开浏览器前失败，而不是在授权码被兑换之后失败。每次失败还附带简短详情（HTTP 状态与服务端错误码，
或本地错误名、消息及系统错误码）：登录页展示该详情，主进程记录日志并上报。诊断包含 attempt id、阶段、错误分类及该详情，
不含回调、PKCE 或会话凭据。

## 本地凭据存储

桌面凭据存储（`userData/config.json`）只是服务端会话的缓存，不是身份来源。当前系统密钥已无法解密的已存凭据不得阻塞登录：
应用就绪且安全存储可用时，将其复制为存储旁带时间戳的 `.bak`，删除该值，用户重新登录即可。无法解析的存储文件在启动时同样被移到一旁。
钥匙串尚无法回答时（应用就绪前或加密不可用时）绝不丢弃已存值，因为之后仍可能可读。

## 认证与工作区准备

认证成功后先发布身份，再加载组织信息。组织加载和当前工作区选择是独立、可重试的操作；其失败不得撤销身份。
工作区数据未就绪时仍由现有工作区守卫阻止访问。CLI 重启是认证成功后的尽力操作，不是登录前提。

浏览器仍需确认要转交的账号。自动回跳和手动打开应用可以安全地发送相同回调。桌面重新发起登录时生成新的 state 和 verifier。
继续使用 Better Auth 1.5.5 的 `/electron/token` 契约及 cookie/session 插件；桌面接管 PKCE 记录，不再使用 SDK 另一个内存 attempt 表。
浏览器回调仍携带 base64url 编码的 `{ identifier, state }`。

## 证据与限制

- 主进程协调器：[desktop-login.ts](../apps/electron/src/main/services/desktop-login.ts)。
- renderer 状态投影：[auth.ts](../apps/electron/src/renderer/src/auth.ts)。
- 凭据存储恢复：[auth-storage.ts](../apps/electron/src/main/auth-storage.ts)。
- 行为测试：[回调测试](../apps/electron/src/renderer/src/auth-callback-transaction.test.mjs)、
  [存储测试](../apps/electron/src/main/auth-storage.test.mjs)。
- 决策与验证：[记录](../.agents/notes/implemented/architecture/2026-09-17-desktop-login-coordinator.zh.md)；
  [不可读凭据存储](../.agents/notes/implemented/bug-fix/2026-09-19-desktop-login-unreadable-credential-store.zh.md)。
- 真实托管认证与操作系统协议分发仍需打包应用验收；合成测试不能证明这些边界。
