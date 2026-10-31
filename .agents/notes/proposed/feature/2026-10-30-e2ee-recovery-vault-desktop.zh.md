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

记录这些决定的 [Spec](../../../../specs/e2ee/recovery-vault.zh.md) 修订在 owner 批准前保持 draft。
私有后端目前还没有 `e2eeRecoveryVault` 存储。以上均未在真机上测试。

## 问题

MVP 要求用户至少配对两台设备。保险库覆盖没有设备幸存的情况，但目前只有 `packages/e2ee-core`
和 Lab 在使用它。[开放契约 note](../architecture/2026-10-15-e2ee-open-contracts.zh.md) 将保险库
列为仅在 core 中实现。[#2125](https://github.com/LodyAI/Lody/pull/2125) 加了一个默认关闭的桌面
闭环：创建账号保险库及其恢复文件，再检查文件。它在本修订批准前保持 draft。

## 决定与被否决的选项

**1. 保险库范围：每个账号一个。** core 索引本来就能容纳多个工作区条目。
- *否决：每个工作区一个保险库。* 用户得为每个工作区保管一份文件，每新建一个工作区都要再做一次离线备份。

**2. 保存 V：允许，但每次使用都须用户在场。**
- macOS 用带用户在场访问控制的钥匙串项（Touch ID 或账户密码），Windows 用 Windows Hello 或凭据提示。
- 这是对"设备密钥无需每次批准"规则的有意例外，仅适用于 V（见
  [客户端保管 Spec](../../../../specs/e2ee/client-custody.zh.md)）。
- 平台无法强制用户在场时，每次都要求用户提供恢复文件。
- *否决：无感保存。* 被攻破或被借用的已解锁设备可以在用户不知情时打开所有保险库条目。
- *否决：始终要求提供文件。* 每代测试会过期，新工作区设置也需要那份离线文件。

**3. 恢复设备认证：HKDF 派生凭据。**
- 凭据用 HKDF-SHA256 从 R 的 Ed25519 种子派生；salt 为 genesis 哈希，info 为
  `lody-e2ee/recovery-credential/v1\0` 后接 R 的公钥。
- 在追加 R 的接纳记录时，通过现有 `credentialHash` 字段登记凭据的 SHA-256。
- *否决：把凭据存进恢复包。* 这会改变已批准的 `formatVersion: 1` 字段集。
- *否决：签名挑战路由。* 它要给后端新增一套认证协议；派生凭据则复用现有设备凭据路径。

**4. PRF：原生 macOS AuthenticationServices，macOS 15+。**
- 前置条件：提供 apple-app-site-association（AASA）文件的 Lody RP 域名、`webcredentials:`
  entitlement、内嵌 provisioning profile，以及对原生依赖的审查。
- 只认真实 ceremony：PRF `enabled: true` 且 `results.first` 为 32 字节。没有降级。
- *否决：系统浏览器 ceremony。* RP 下发的 JavaScript 和本地交接会进入信任基，loopback 端口或
  URL scheme 也可能被抢占。
- *否决：修补 Electron。* 要么 fork 运行时，要么等上游。
- *否决：Electron 内置 authenticator。* 它们不返回 PRF（见下方调研结论）。

**5. 恢复包私钥：48 字节 RFC 8410 PKCS#8 精确编码。** 已在
[#2124](https://github.com/LodyAI/Lody/pull/2124) 中实现。

**6. 恢复后：通知该账号所有在用设备及账号邮箱。**
- *否决：强制更换 R、owner 审批和冷却期。* owner 选择优先保证可恢复性；替换与撤销仍由用户显式操作。
- 通知只起告知作用。恶意服务端可以扣下它，但 R 签署的接纳记录仍在已验证账本中可见。

## 后端缺口

私有后端已有 `recovery` 设备类型，但以下各项都还没有，每一项都会阻碍对接真实服务端：

- `e2eeRecoveryVault` 存储：不可变条目、在同一事务内检查被引用条目存在的索引 CAS，以及
  `deleteUnreferenced`、按账号隔离和配额；
- Recovery 凭据哈希登记；
- 以 R 身份认证的邮箱读取与追加；
- 恢复通知。

## 平台结论：macOS 上的 WebAuthn PRF

2026-10-30 依据公开资料调研，未在设备上实测。Lody 锁定 Electron 44.9.3。

| 路径 | PRF 结果 | 前提 | 来源 |
| --- | --- | --- | --- |
| Electron Touch ID authenticator（41.5+） | 无（从不设置 `supports_prf`） | `keychain-access-groups`；绑定单台设备 | [electron#51255](https://github.com/electron/electron/pull/51255) |
| Electron `platformPasskeys`（仅 45） | 忽略 PRF 输入 | 关联域、内嵌 profile、AASA | [electron#51563](https://github.com/electron/electron/pull/51563) |
| Chromium iCloud 钥匙串 authenticator | 有，macOS 15+ | 浏览器专用 entitlement | [Chromium CL](https://chromium.googlesource.com/chromium/src/+/7fe5155fed538b1d2317c516ddc633ee7fa206ef%5E%21) |
| 原生 AuthenticationServices（已选） | 有，macOS 15+，32 字节 | `webcredentials:`、application identifier、内嵌 profile、AASA | [Apple 文档](https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct)、[vault12/electron-webauthn-mac](https://github.com/vault12/electron-webauthn-mac) |
| 在 RP 域名上用系统浏览器 | 有（Safari 18、Chrome 132+） | 需要把结果交回应用 | 分析 |

`file://` 或自定义 scheme 的渲染端根本无法调用 WebAuthn。Associated Domains 标明可用于
Developer ID 应用，但没有端到端成功的报告。

## 后果与局限

所有能力默认关闭，不改变配对、账本和工作区行为。以下几点仍未验证：

- macOS 与 Windows 的用户在场机制在真机上的表现；
- 原生模块与关联域能否在 Developer ID 构建中工作；
- 上面列出的后端工作。

R 凭据参数属于本次 draft 修订，需要 owner 一并批准。
