# E2EE Spec 批准范围

Status: implemented
Translation: current

[English](2026-10-28-e2ee-spec-approval.md)

## 摘要

Owner Zixuan Chen（zxch3n）于 2026-10-28 批准所列 E2EE Spec 修订，并于 2026-10-29 批准下述 client custody Spec 确切修订。权限账本仅批准已确认或已实现部分；账本 v1 冻结前，未定格式细节须单独审查。桌面保管在产品启用前须完成真机验收。Client custody 批准确立意图，不代表平台验收；恢复库保持 draft。

## 决定

Owner 批准了[原子移除](../../../../specs/e2ee/atomic-removal.zh.md)、[发布者密钥可恢复性](../../../../specs/e2ee/publisher-key-recoverability.zh.md)、[快照加入](../../../../specs/e2ee/snapshot-join.zh.md)及[桌面保管](../../../../specs/e2ee/desktop-custody.zh.md)。产品启用前须在真机验收中验证打包 Electron 与 macOS、Windows 的真实系统钥匙串。

[权限账本](../../../../specs/e2ee/permission-ledger.zh.md)仅批准已确认或已实现部分。第 9 节及标为待确认、待审或待定的字段与参数不在批准范围；账本 v1 冻结前须单独进行格式审查。[恢复库](../../../../specs/e2ee/recovery-vault.zh.md)保持 draft，不在 MVP 范围内。批准不代表产品已启用或真机验收已完成。

2026-10-28，owner Zixuan Chen（zxch3n）通过 E2EE 总调度进一步批准现有实现的 tag 9 能力声明、capability 1 和 tag 10 移除，包括现有 1–16 个严格递增非零 u32 能力码、现有长度上限，以及遇到不支持的声明时以 `upgrade-required` 停止。此决定来自[冻结前审查](https://github.com/LodyAI/Lody/pull/2026)；恢复格式问题及第 9 节仍不在此次批准范围。

2026-10-28，owner Zixuan Chen（zxch3n）通过 E2EE 总调度批准恢复设备 tag 4 与 `possess/v2` 字节不变、不修改 genesis；恢复 generation 和可信账本材料保存在加密恢复包中，可信锚由外部独立确认。owner 同时批准恢复包 `formatVersion: 1` 与验收条件：独立确认可信锚、导入恢复密钥、实际解密当前代信封并核对承诺。这些是格式边界，不代表整个[恢复保险库 Spec](../../../../specs/e2ee/recovery-vault.zh.md)获批；保险库仍为 draft，且不在 MVP 内。[格式审查](https://github.com/LodyAI/Lody/pull/2026)记录字节形状和依据。2026-10-31，owner 经 E2EE 总调度另行接受：两个恢复私钥必须分别是 Ed25519 与 X25519 的 48 字节 RFC 8410 PKCS#8 精确编码（[#2124](https://github.com/LodyAI/Lody/pull/2124)），其他编码一律拒绝。这只是包格式边界，保险库 Spec 仍为 draft。

## Web 与移动端保管授权

2026-10-29，owner Zixuan Chen（zxch3n）通过 E2EE 总调度在实现任务中转达批准：Web 信任服务端下发代码并在界面/文档如实说明；持久不可导出 AES-GCM KEK 包装纯 JS Ed25519/X25519 密钥；手机使用设备绑定、首次解锁后可用的保护；存储丢失、重装或安装状态不明时须桌面重新审批。必须有持久保护，无明文回退或自动替换身份，账本 v1 及其字节保持不变。

未选择仅靠原生曲线保管，因为浏览器/原生曲线支持不能提高 iOS/iPadOS 16.4 下限。不可导出不隔离应用代码、恶意服务端、XSS 或浏览器入侵。本记录仅含获准公开的决定范围，不含私有任务或部署记录。Client custody 的确切修订批准见下文；实现、平台验收、部署和恢复库批准分别处理，桌面真实钥匙串验收仍是前置条件。

## Client custody 修订批准

2026-10-29，owner Zixuan Chen（zxch3n）明确批准 revision `e1e3b5a10f65d94655d097cd262f008a35c2688e` 的 client custody Spec，由 E2EE 总调度针对 [PR #2038](https://github.com/LodyAI/Lody/pull/2038)转达。[获批英文文本](https://github.com/LodyAI/Lody/blob/e1e3b5a10f65d94655d097cd262f008a35c2688e/specs/e2ee/client-custody.md)的 Git blob 为 `d2a817abf5ccf10d72496e6fa3b453ca74e37de2`；[获批中文文本](https://github.com/LodyAI/Lody/blob/e1e3b5a10f65d94655d097cd262f008a35c2688e/specs/e2ee/client-custody.zh.md)的 Git blob 为 `af4b5d9842b96101f1fa38d2cf0909780e552517`。Owner 确认以下五点范围：

1. 网页应用代码可以解包并使用私钥。接受并如实披露服务端下发代码的信任边界；不可导出 KEK 不隔离这些代码。
2. 手机保护在首次解锁后可用，不要求逐次生物识别。Android 不承诺 TEE 或 StrongBox。
3. 仅当保留证据确认同一次中断安装时，才允许原地恢复；否则必须桌面重新审批并原子替换身份，保留旧回执和未决原件。
4. 普通 logout 和清缓存保留身份及未决原件。
5. 账本 v1 及其字节保持不变。Spec 批准不是实现、部署或真机验收，也不批准恢复库。

该 revision 之后新增的批准元数据及链接不改变其技术正文。[当前 Spec](../../../../specs/e2ee/client-custody.zh.md)记录此批准；实际原生 Keychain/Keystore、首次解锁、最低 OS 与真机验收仍须分别提供证据。

2026-10-29，Owner Zixuan Chen 经 E2EE 总调度批准以 480 秒 E2EE 内容 token 作为上线缓解：480 秒有效期 + 60 秒 JWT 宽限 + 一段 300 秒 SSE，常规预算为 840 秒。其余 60 秒仅为余量，不保证覆盖缓冲、上游等待/重试、时钟误差或存储提交。严格 gateway 期限执行列为后续项，不阻塞上线。本文记录决定，不证明私有后端已部署或真实 gateway 已验收；独立移除与稍后手动换钥维持已批准的 tag 10 语义。
