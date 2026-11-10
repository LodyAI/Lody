# E2EE 恢复保险库桌面接入

Status: proposed
Translation: current

[English](2026-10-30-e2ee-recovery-vault-desktop.md)

## 摘要

core 已实现 vault-v1 恢复，但还没有产品使用它，所以丢失全部已配对设备的用户会失去加密工作区。
2026-10-31，owner 经 E2EE 总调度对六个接入问题作出决定：

- 每个账号一个保险库；
- V 可以保存在桌面上，但每次使用都须用户在场；
- R 用 HKDF 派生的凭据认证，并通过 `credentialHash` 登记；
- PRF 走原生 macOS 模块；
- 接受 RFC 8410 PKCS#8 恢复包规则；
- 恢复成功后通知用户的设备和邮箱，不加其他关卡。

记录这些决定的 [Spec](../../../../specs/e2ee/recovery-vault.zh.md) 修订已于 2026-10-31 获 owner 批准。
2026-11-06，owner 批准了一次[修订](../../implemented/architecture/2026-10-28-e2ee-spec-approval.zh.md#恢复保险库-passkey-解锁与可信锚)：增加 iPhone 和 Web 的
passkey 解锁，任何返回真实 PRF 结果的 passkey 都能用，并以通过认证的恢复包里的 genesis 为可信锚。
这取代了决定 4 只覆盖 macOS 的范围和独立确认。

2026-11-06，owner 还批准了针对丢失或泄露恢复文件的[整库换新](../../implemented/architecture/2026-10-28-e2ee-spec-approval.zh.md#恢复保险库整库换新)。
它保留一个当前保险库和一个恢复文件，允许一个临时的 `replacing` 保险库，并把已退役保险库上限设为 16 份。
它是对上面六项决定的补充，不是取代。以上均未在真机上测试。

## 问题

MVP 要求用户至少配对两台设备。保险库覆盖没有设备幸存的情况，但目前只有 `packages/e2ee-core`
和 Lab 在使用它。[开放契约 note](../architecture/2026-10-15-e2ee-open-contracts.zh.md) 将保险库
列为仅在 core 中实现。[#2125](https://github.com/LodyAI/Lody/pull/2125) 加了一个默认关闭的桌面
闭环：创建账号保险库及其恢复文件，再检查文件。它既不保留 V，也不接纳 R，所以决定 2、3 只约束后续工作。

## 决定与被否决的选项

**1. 保险库范围：每个账号一个。** core 索引本来就能容纳多个工作区条目。
[整库换新修订](../../implemented/architecture/2026-10-28-e2ee-spec-approval.zh.md#恢复保险库整库换新)保留一个 `current` 保险库和一个恢复文件，
允许一个临时的 `replacing` 保险库，并把已退役保险库上限设为 16 份。

- _否决：每个工作区一个保险库。_ 用户得为每个工作区保管一份文件，每新建一个工作区都要再做一次离线备份。

**2. 保存 V：允许，但每次使用都须用户在场。**

- macOS 用带用户在场访问控制的钥匙串项（Touch ID 或账户密码），Windows 用 Windows Hello 或凭据提示。
- 这是对"设备密钥无需每次批准"规则的有意例外，仅适用于 V（见
  [客户端保管 Spec](../../../../specs/e2ee/client-custody.zh.md)）。
- 平台无法强制用户在场时，每次都要求用户提供恢复文件。
- _否决：无感保存。_ 被攻破或被借用的已解锁设备可以在用户不知情时打开所有保险库条目。
- _否决：始终要求提供文件。_ 每代测试会过期，新工作区设置也需要那份离线文件。

**3. 恢复设备认证：HKDF 派生凭据。**

- 凭据用 HKDF-SHA256 从 R 的 Ed25519 种子派生；salt 为 genesis 哈希，info 为
  `lody-e2ee/recovery-credential/v1\0` 后接 R 的公钥。
- 在追加 R 的接纳记录时，通过现有 `credentialHash` 字段登记凭据的 SHA-256。
- _否决：把凭据存进恢复包。_ 这会改变已批准的 `formatVersion: 1` 字段集。
- _否决：签名挑战路由。_ 它要给后端新增一套认证协议；派生凭据则复用现有设备凭据路径。

**4. PRF：原生 macOS AuthenticationServices，macOS 15+。**

- 前置条件：提供 apple-app-site-association（AASA）文件的 Lody RP 域名、`webcredentials:`
  entitlement、内嵌 provisioning profile，以及对原生依赖的审查。
- 只认真实 ceremony：PRF `enabled: true` 且 `results.first` 为 32 字节。没有降级。
- _否决：系统浏览器 ceremony。_ RP 下发的 JavaScript 和本地交接会进入信任基，loopback 端口或
  URL scheme 也可能被抢占。
- _否决：修补 Electron。_ 要么 fork 运行时，要么等上游。
- _否决：Electron 内置 authenticator。_ 它们不返回 PRF（见下方调研结论）。

**5. 恢复包私钥：48 字节 RFC 8410 PKCS#8 精确编码。** 已在
[#2124](https://github.com/LodyAI/Lody/pull/2124) 中实现。

**6. 恢复后：通知该账号所有在用设备及账号邮箱。**

- _否决：强制更换 R、owner 审批和冷却期。_ owner 选择优先保证可恢复性；替换与撤销仍由用户显式操作。
- 通知只起告知作用。恶意服务端可以扣下它，但 R 签署的接纳记录仍在已验证账本中可见。

## 后端缺口

2026-11-05 查看时，私有后端已经实现保险库存储、Recovery 凭据哈希、以 R 身份认证的邮箱读取和 R 的接纳追加，
全部由默认关闭的开关控制。对接真实服务端还差两项：

- R 读取已提交的暂存信封；
- 恢复通知。

## 平台结论：macOS 上的 WebAuthn PRF

2026-10-30 依据公开资料调研，未在设备上实测。Lody 锁定 Electron 44.9.3。

| 路径                                     | PRF 结果                      | 前提                                                          | 来源                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron Touch ID authenticator（41.5+） | 无（从不设置 `supports_prf`） | `keychain-access-groups`；绑定单台设备                        | [electron#51255](https://github.com/electron/electron/pull/51255)                                                                                                                                                                  |
| Electron `platformPasskeys`（仅 45）     | 忽略 PRF 输入                 | 关联域、内嵌 profile、AASA                                    | [electron#51563](https://github.com/electron/electron/pull/51563)                                                                                                                                                                  |
| Chromium iCloud 钥匙串 authenticator     | 有，macOS 15+                 | 浏览器专用 entitlement                                        | [Chromium CL](https://chromium.googlesource.com/chromium/src/+/7fe5155fed538b1d2317c516ddc633ee7fa206ef%5E%21)                                                                                                                     |
| 原生 AuthenticationServices（已选）      | 有，macOS 15+，32 字节        | `webcredentials:`、application identifier、内嵌 profile、AASA | [Apple 文档](https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct)、[vault12/electron-webauthn-mac](https://github.com/vault12/electron-webauthn-mac) |
| 在 RP 域名上用系统浏览器                 | 有（Safari 18、Chrome 132+）  | 需要把结果交回应用                                            | 分析                                                                                                                                                                                                                               |

`file://` 或自定义 scheme 的渲染端根本无法调用 WebAuthn。Associated Domains 标明可用于
Developer ID 应用，但没有端到端成功的报告。

## 可行性 spike：Developer ID、AuthenticationServices 与 PRF

静态部分，2026-11-07，在 Linux 上完成。没有在 Mac 上构建、签名或运行过任何东西，所以可行性仍未证实。公开资料也没有定论：
Apple 的[授权项说明](https://developer.apple.com/tutorials/data/documentation/bundleresources/entitlements/com.apple.developer.associated-domains.md)和
[passkey 指南](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys.md)都没有谈 Developer ID。
[TeamDev 的指南](https://teamdev.com/mobrowser/tutorials/features/touch-id/)为 Chromium 应用嵌入了 Developer ID profile，但针对的是 Touch ID 钥匙串组，
不是 `webcredentials`。[Clerk](https://clerk.com/docs/reference/electron/passkeys) 和
[electron-webauthn-mac](https://awesome.ecosyste.ms/projects/github.com%2Fvault12%2Felectron-webauthn-mac) 只描述了开发签名。

仓库现状：

- 云端桌面版是私有仓 `apps/electron-cloud/electron-builder.yml` 里的 `ai.lody.desktop`。`dev.loro.lody.oss` 是不连云的公开版，没有保险库，所以下面的检查针对云端版。iOS 是 `ai.lody.mobile`。
- `apps/electron/electron-builder.yml` 使用 hardened runtime 和公证，应用用 `entitlements`，嵌套二进制用 `entitlementsInherit`。
- `build/entitlements.mac.plist` 没有 `com.apple.developer.associated-domains`、`com.apple.application-identifier` 和
  `com.apple.developer.team-identifier`，也没有嵌入 profile。这三项都需要，只放在主应用上，不放进 inherit plist。
- 主应用保留 library validation，所以原生模块必须由同一团队签名。现有的 `electron-sparkle-updater` 原生模块是打包先例。

electron-builder 的 `mac.provisioningProfile` 能否嵌入 Developer ID profile，以及 Sparkle 更新后它是否仍然有效，要在第一次签名构建时确认。

在 Mac 上按顺序执行，遇到第一个失败就停下：

1. **签名。** 用 profile 和新授权项构建。`codesign -d --entitlements - Lody.app` 能列出这三项，`spctl -a -vv Lody.app` 接受，公证后能启动。这里启动失败是主要风险。
2. **关联。** `curl https://app-site-association.cdn-apple.com/a/v1/lody.ai` 返回文件，`sudo swcutil show` 列出应用和这个域名。
3. **Ceremony。** 用一个最小原生模块为 `lody.ai` 创建带 PRF 输入的平台 passkey，并锚定到 `BrowserWindow`。系统弹窗显示 RP，注册报告支持 PRF。
4. **PRF。** 认证返回 32 字节，第二次认证以及通过 iCloud 钥匙串在第二台 Mac 上得到相同字节。
5. **更新。** 从一个签名版本 Sparkle 更新到下一个后，第 2 到 4 步仍然正常。

如果第 1 或第 2 步失败，Developer ID 就走不通这条路。退路是 macOS 上只用恢复文件，passkey 只留给 iPhone 和 Web 界面，这需要 owner 决定。

## 同源网页恢复修订

owner 于 2026-11-10 指示取代专用主机方案：恢复直接在普通 `lody.ai` 客户端中完成，RP 为 `lody.ai`，不再创建设备 C、跨页通道或手动复制备用步骤。这把系统仪式的信任范围扩大到父域及子域，包括官网与统计脚本。仍须系统验证。[修订后的 Spec](../../../../specs/e2ee/recovery-vault.zh.md#passkey-解锁) 已由 zxch3n 于 2026-11-10 批准，但不据此启用功能。临时明文等实际操作结束后清理，加密重试记录保留。复用现有应用负责人：备份只租借并释放自己的 reader，恢复沿用原设备身份，失败不得关闭内容 reader。

## 后果与局限

所有能力默认关闭，不改变配对、账本和工作区行为。以下几点仍未验证：

- macOS 与 Windows 的用户在场机制在真机上的表现；
- 原生模块与关联域能否在 Developer ID 构建中工作；
- 整库换新流程及其已退役保险库 16 份上限是否符合规定；
- 上面列出的后端工作。

owner 已随 Spec 修订一并批准 R 凭据参数。

## 网页恢复的取舍

2026-11-09 批准的 PRF 加恢复文件仍保留。2026-11-10 同源方向用专用主机隔离换取在应用中直接完成操作。密码加 Secret Key 仍须完整 KDF 与包装协议审查；短密码不能作为 PRF 缺失时的自动降级。

下表来源曾于 2026-11-10 查证，不代表产品验收。

| 对象 | 已查证的机制与来源 | 对 Lody 的意义 |
| --- | --- | --- |
| 1Password 的密码＋Secret Key 路径 | [官方 SRP 说明](https://1password.com/blog/developers-how-we-use-srp-and-you-can-too)区分双秘密派生 2SKD 与不传密码的 SRP 认证；[Secret Key 说明](https://support.1password.com/secret-key-security/)解释随机秘密加强服务端密文的保护。 | 可以学用户现场开包的体验，不能只复制“密码”输入框便声称等同其安全模型；本提案不改 Lody 登录为 SRP。 |
| Proton Pass | [安全模型](https://proton.me/blog/proton-pass-security-model)使用 SRP 认证、由密码经 bcrypt 保护用户钥，再打开 vault/item 密钥。 | 浏览器可做分层客户端解密；不证明密码包装可直接接到 Lody 已批准的恢复格式。 |
| MetaMask 扩展的助记词路径 | [官方 passkey 说明](https://support.metamask.io/configure/wallet/passkeys/)描述本地密码保护 vault、passkey 包装本地加密钥；本地 vault 不随同步 passkey 自动出现在另一安装。此处 SRP 指 Secret Recovery Phrase，不是 Secure Remote Password。 | 扩展的本地保险库不等于普通网站从云端自助取回工作区；不推断其社交登录路径。 |
| WhatsApp Web 的关联设备 | [官方多设备架构](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/)描述各设备独立身份、通过手机扫码关联，关联后可独立连接。此来源是 2021 年的架构说明。 | 适合保留设备批准入口，不能满足“另一台设备不在手边也能首次解锁”。不据此声称其所有现行流程仍相同。 |
| WebAuthn PRF | [W3C 标准](https://www.w3.org/TR/webauthn-3/#prf-extension)定义每凭据的 32 字节伪随机输出，可用于加密。 | 普通 passkey 签名不是解密钥；必须验证真实 PRF，兼容性不能只看浏览器名字。 |

**归属与替代检查。** 本 proposed Note 仍拥有原生与恢复集成理由，仅网页计划被取代。历史批准记录保留；没有已实施 Note 被完整替代。

**证据界限。** 本次核对了公开 Spec、`packages/e2ee-core/src/internal/recovery/crypto.ts`
和固定向量位置，没有运行解锁或配对，也未验证私有部署和 Ryugi 画布。上文早期的
产品接入、PR 状态与平台缺口是当时核查记录，本提案不把它们当作今天的已核实状态。

### 可移植恢复 host 边界

显式恢复命令拥有一个已准备身份和恢复密钥的 Scope。它先认证恢复包与账号，再准备
身份，保留接纳原件，通过已验证获准的 session 安装密钥。取消和关闭沿用现有 owned
host 排空，不新增后台负责人或替换路径。安装失败保留身份与原件供续做；独立工作区
及已获准的内容仍可用。Chromium 用例覆盖坏包、错误账号、已撤销 R、安装失败、精确
续做和持久重开；私有 Web 入口和部署仍须另行验收。
