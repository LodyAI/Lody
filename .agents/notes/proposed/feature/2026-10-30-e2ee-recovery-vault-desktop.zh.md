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

- `apps/electron/electron-builder.yml` 使用 hardened runtime 和公证，应用用 `entitlements`，嵌套二进制用 `entitlementsInherit`。
- `build/entitlements.mac.plist` 没有 `com.apple.developer.associated-domains`、`com.apple.application-identifier` 和
  `com.apple.developer.team-identifier`，也没有嵌入 profile。这三项都需要，只放在主应用上，不放进 inherit plist。
- 主应用保留 library validation，所以原生模块必须由同一团队签名。现有的 `electron-sparkle-updater` 原生模块是打包先例。

electron-builder 的 `mac.provisioningProfile` 能否嵌入 Developer ID profile，以及 Sparkle 更新后它是否仍然有效，要在第一次签名构建时确认。

在 Mac 上按顺序执行，遇到第一个失败就停下：

1. **签名。** 用 profile 和新授权项构建。`codesign -d --entitlements - Lody.app` 能列出这三项，`spctl -a -vv Lody.app` 接受，公证后能启动。这里启动失败是主要风险。
2. **关联。** `curl https://app-site-association.cdn-apple.com/a/v1/vault.lody.ai` 返回文件，`sudo swcutil show` 列出应用和这个域名。
3. **Ceremony。** 用一个最小原生模块为 `vault.lody.ai` 创建带 PRF 输入的平台 passkey，并锚定到 `BrowserWindow`。系统弹窗显示 RP，注册报告支持 PRF。
4. **PRF。** 认证返回 32 字节，第二次认证以及通过 iCloud 钥匙串在第二台 Mac 上得到相同字节。
5. **更新。** 从一个签名版本 Sparkle 更新到下一个后，第 2 到 4 步仍然正常。

如果第 1 或第 2 步失败，Developer ID 就走不通这条路。退路是 macOS 上只用恢复文件，passkey 只留给 iPhone 和 Web 界面，这需要 owner 决定。

## 后果与局限

所有能力默认关闭，不改变配对、账本和工作区行为。以下几点仍未验证：

- macOS 与 Windows 的用户在场机制在真机上的表现；
- 原生模块与关联域能否在 Developer ID 构建中工作；
- 整库换新流程及其已退役保险库 16 份上限是否符合规定；
- 上面列出的后端工作。

owner 已随 Spec 修订一并批准 R 凭据参数。
