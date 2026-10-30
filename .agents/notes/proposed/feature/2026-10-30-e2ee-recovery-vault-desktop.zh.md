# E2EE 恢复保险库桌面接入

Status: proposed
Translation: current

[English](2026-10-30-e2ee-recovery-vault-desktop.md)

## 摘要

core 已实现 vault-v1 恢复，但没有任何产品界面使用它，因此丢失全部已配对设备的用户会失去加密
工作区。本 note 提议一个默认关闭、只用恢复文件的桌面接入：创建账号保险库、为各工作区设置
Recovery 设备、从文件恢复。macOS 上的 Electron 44 无法返回 WebAuthn PRF 结果，所以推迟 PRF。
端到端恢复还需要私有后端为 Recovery 设备提供认证路径，本仓库无法提供。以上均未在真机上测试。

## 问题

MVP 要求用户至少配对两台设备。[恢复保险库 Spec](../../../../specs/e2ee/recovery-vault.zh.md)
覆盖剩下的情况，但只有 `packages/e2ee-core` 与 Lab 使用它。桌面端没有生产用的
`RecoveryVaultStore` 或 `RecoveryVaultLocalStore` 适配器，没有对已声明的 `e2eeRecoveryVault`
函数的 Convex 调用，也没有 UI。[开放契约 note](../architecture/2026-10-15-e2ee-open-contracts.zh.md)
将保险库列为仅在 core 中实现。

## 提案

- **开关。** 只有 `LODY_E2EE_RECOVERY_VAULT=1` 时主进程才暴露恢复 IPC。渲染端还需要开发者模式
  加一个默认关闭的设置。任一开关关闭时，不运行任何保险库、ceremony、网络或存储工作。
- **每账号一个保险库。** 每个账号一个保险库、一个恢复文件。core 索引本来就能容纳多个工作区条目，
  用户只需保管一个文件，而不是每个工作区一个。主进程通过原生保存对话框写文件，解锁密钥不进入渲染端。
- **本地日志。** SQLite `RecoveryVaultLocalStore` 放在账号的 E2EE 目录。按 core 要求，它只保存
  加密条目、原始签名记录和非机密进度。
- **服务端。** Convex `RecoveryVaultStore` 调用 `api.e2eeRecoveryVault.*`，用 `@lody/e2ee-core/host`
  DTO 解码回复。
- **最小首个闭环。** 创建保险库并保存文件，然后用该文件重新打开保险库并解密索引。这证明文件能
  通过真实服务端解锁保险库。工作区设置与恢复等 Recovery 设备能够认证后再做。

## 平台结论：macOS 上的 WebAuthn PRF

2026-10-30 依据公开资料调研，未在设备上实测。

| 路径 | PRF 结果 | 前提 | 来源 |
| --- | --- | --- | --- |
| Electron Touch ID authenticator（`app.configureWebAuthn`，41.5+） | 无：Chromium 的 Touch ID authenticator 从不设置 `supports_prf` | `keychain-access-groups`；凭据只在单台设备上 | [electron#51255](https://github.com/electron/electron/pull/51255) |
| Electron `platformPasskeys`（iCloud 钥匙串） | 被忽略：Electron 文档写明 PRF 输入被忽略 | 仅 Electron 45；关联域、内嵌 profile、AASA | [electron#51563](https://github.com/electron/electron/pull/51563) |
| Chromium 自带的 iCloud 钥匙串 authenticator | 有，macOS 15+ | 浏览器专用 entitlement，Apple 只发给真正的网页浏览器 | [Chromium CL](https://chromium.googlesource.com/chromium/src/+/7fe5155fed538b1d2317c516ddc633ee7fa206ef%5E%21) |
| 原生 AuthenticationServices 模块（如 `vault12/electron-webauthn-mac`） | 有，macOS 15+，32 字节输出 | `webcredentials:` 关联域、application identifier、内嵌 profile、AASA | [Apple 文档](https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct)、[模块](https://github.com/vault12/electron-webauthn-mac) |
| 在 RP 的 https 域名上用系统浏览器完成 ceremony | 有，Safari 18 和 Chrome 132+ | 需把结果交回应用；RP 网页源进入信任基 | 分析 |

Lody 锁定 Electron 44.9.3。WebAuthn 还要求 https 源的可注册域名与 RP ID 匹配，所以 `file://`
或自定义 scheme 的渲染端根本无法调用它。Developer ID 构建可以使用 Associated Domains，但没有
端到端成功的报告。

## 备选方案

**PRF 路线。**

- *原生模块（建议作为下一步）。* ceremony 留在应用内，能报告真实 PRF 结果，再由 core 通过
  `verifiedPasskeyPrf` 校验。代价：仅 macOS 15+，需要提供 AASA 的 RP 域名、打包应用内的
  provisioning profile，以及一个需审查的原生依赖。
- *系统浏览器。* 不需要原生代码。但原始 PRF 输出或由它派生的密钥会经过 RP 下发的 JavaScript
  和本地交接。本地进程可以抢占 loopback 端口或 URL scheme。缓解方式是用 HPKE 封装交给应用的
  临时密钥，并比对短确认码。RP 服务端仍在信任基内。
- *修补 Electron。* 把 PRF 接入 Electron 的平台 passkey authenticator 看起来改动不大，但要么
  fork 运行时，要么等上游。
- *不做 PRF。* 首个版本只用恢复文件就够。

**R 如何向服务端认证。**

- *派生 R 的访问凭据（建议）。* 用新域对 R 的签名私钥做 HKDF，并通过现有 `credentialHash` 字段
  在 R 的接纳追加时登记其哈希。已批准的包格式保持不变，但私有后端必须为 Recovery 类型的接纳
  接受这个哈希。
- *为 Recovery 设备做签名挑战。* 需要新的后端路由。
- *把凭据存进恢复包。* 已否决：它改变已批准的 `formatVersion: 1` 字段集。

**桌面是否保留 V。**

- *用 OS 保管包装 V。* 新工作区的设置和每代测试无需文件即可运行。该设备本就持有这些工作区的
  密钥，但 V 还能解锁保险库中的其他所有条目。
- *每次都要求文件。* 静态存储更安全，但测试更容易过期。

## 后果与局限

所有提议的能力默认关闭，不改变现有配对、账本和工作区行为。两点未经验证：私有后端是否已部署
`e2eeRecoveryVault` 函数，以及它能否认证 Recovery 设备。待 owner 决定的问题列在 Spec 的接入一节中。
