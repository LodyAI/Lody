# E2EE Spec 批准范围

Status: implemented
Translation: current

[English](2026-10-28-e2ee-spec-approval.md)

## 摘要

Owner Zixuan Chen（zxch3n）于 2026-10-28 批准所列 E2EE Spec 修订，并于 2026-10-29 批准下述 client custody Spec 确切修订。权限账本仅批准已确认或已实现部分；账本 v1 冻结前，未定格式细节须单独审查。桌面保管在产品启用前须完成真机验收。Client custody 批准确立意图，不代表平台验收。2026-10-31 owner 批准了下述恢复保险库 Spec 修订，2026-11-01 批准了账号级个人设备配对增量，2026-11-02 批准了机器共享 Spec。

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

## 设备撤销保留例外

2026-10-31，owner Zixuan Chen（zxch3n）经 E2EE 协调者批准，把普通密钥保留规则的例外扩展到凭据确认的本设备撤销，对应修订 `145c7a5e61e71b04f8b89e7801b01bb0fcccd9fc`。批准的文本为 [desktop custody](https://github.com/LodyAI/Lody/blob/145c7a5e61e71b04f8b89e7801b01bb0fcccd9fc/specs/e2ee/desktop-custody.zh.md)（英文 blob `cbfc986784d7fe89a162bf0fd29f16b76124574a`，中文 `7cecb36a44e25ba814110fc68240ff3c80ec4c61`）、[client custody](https://github.com/LodyAI/Lody/blob/145c7a5e61e71b04f8b89e7801b01bb0fcccd9fc/specs/e2ee/client-custody.zh.md)（英文 `d19dd471113d3f61ef5451a414761e21b1552898`，中文 `1ea279bfd0abd707a78c053c46cc5f416611364c`）以及[白皮书](https://github.com/LodyAI/Lody/blob/145c7a5e61e71b04f8b89e7801b01bb0fcccd9fc/specs/e2ee/whitepaper.zh.md)中关于本人设备撤销与删除的段落（英文 `dd0aab07ada8c2220cd0fae4beb80d2b894b49b8`，中文 `fcb311aa398f0f9fb6a883d311039ac2e8266ddc`）。范围：只有精确的类型化撤销结果才算数；清理只删除本设备在该工作区的身份、内容和密钥，保留成员资格和该成员的其他设备，并允许用新身份重新配对。普通失败仍不得触发删除。这是诚实客户端清理，不是对此前副本的安全擦除。理由见[桌面设备撤销](2026-10-30-e2ee-desktop-device-revocation.zh.md)。

## 恢复保险库桌面接入

2026-10-31，owner Zixuan Chen（zxch3n）经 E2EE 总调度转达，明确批准 revision `cd752bbfff7a8cb11f11570ed6b76853075d9565` 的恢复保险库 Spec（[PR #2123](https://github.com/LodyAI/Lody/pull/2123)）。[获批英文文本](https://github.com/LodyAI/Lody/blob/cd752bbfff7a8cb11f11570ed6b76853075d9565/specs/e2ee/recovery-vault.md)的 Git blob 为 `b380514af1a0b43f9d26f93cbe0419717596a2f6`；[获批中文文本](https://github.com/LodyAI/Lody/blob/cd752bbfff7a8cb11f11570ed6b76853075d9565/specs/e2ee/recovery-vault.zh.md)的 Git blob 为 `23a1cd28ea6451858844859c31405bad66b95bb0`。批准的 revision 为 `cd752bbf`，之后 Spec 仅有编辑性修改（批准元数据与"已批准"的表述）。批准范围是六项桌面接入决定：

1. 每个账号一个保险库、一个恢复文件。
2. V 只能在每次使用都须用户在场的保护下保存在桌面（macOS 钥匙串用户在场访问控制；Windows Hello 或凭据提示）。这仅是针对 V 的例外；平台不支持时由用户提供恢复文件，绝不无感保存 V。
3. R 的访问凭据为对 R 的 32 字节 Ed25519 种子做 HKDF-SHA256，salt 为 genesis 哈希，info 为 `lody-e2ee/recovery-credential/v1\0` 后接 R 的签名公钥；通过现有 `credentialHash` 登记该凭据的 SHA-256。恢复包格式不变。
4. Passkey PRF 使用 macOS 15+ 原生 AuthenticationServices 模块，需要 Lody 的 `webcredentials:` 关联域、AASA 与内嵌 provisioning profile，并先审查原生依赖。真实 ceremony 必须报告 PRF enabled 且 `results.first` 为 32 字节；没有降级。
5. 恢复包私钥采用 48 字节 RFC 8410 PKCS#8 精确编码。
6. 恢复成功后通知该账号所有在用设备与账号邮箱；不强制更换 R，不加 owner 审批，不设冷却期。

批准只确立意图，不代表已实现、已部署或真机验收。私有后端缺口仍在：没有 `e2eeRecoveryVault` 存储、Recovery 凭据登记、以 R 身份认证的邮箱访问，也没有恢复通知。恢复保险库仍不在 MVP 内。

## Whitepaper 2026-10-31 修订

2026-10-31，owner Zixuan Chen（zxch3n）经 E2EE 总调度转达，批准 [PR #2145](https://github.com/LodyAI/Lody/pull/2145) 中 commit `7efe3f2c05253a98bb5f8c3034c26b48f7a165a0` 的[白皮书](../../../../specs/e2ee/whitepaper.zh.md)修订。[获批英文文本](https://github.com/LodyAI/Lody/blob/7efe3f2c05253a98bb5f8c3034c26b48f7a165a0/specs/e2ee/whitepaper.md)的 Git blob 为 `4421440f723aa15171a2c6a71ee10be9b6829ccd`；[获批中文文本](https://github.com/LodyAI/Lody/blob/7efe3f2c05253a98bb5f8c3034c26b48f7a165a0/specs/e2ee/whitepaper.zh.md)的 Git blob 为 `a324c87d687adfa5a11617064eada76005f4633c`。

批准范围是三路只读审计（审计 `c990a689` 加 #2143）后与 `main` 对齐的修订，以及描述当前行为的新表述：

- 按已批准 client custody Spec 的 Web 个人设备保管；恢复保险库（2026-10-31 批准）与桌面保管的批准及其实现限制。
- Streams epoch 钥 provider、快照加入与安全码 UI 现状、历史解密与执行权限分离（#2143），以及计费与禁用的旧接口。
- 一项优先可用性与后端成本的换代 owner 决定：当前钥已安装时，新内容使用已验证的当前 epoch；新 epoch 发布后，尚未收到当前钥的设备最多 15 分钟内可继续用最新已保留的已发布 epoch 封装，超时后新写入失败并可重试。后端不强制检查内容 epoch。被移除或撤销的设备在这段时间内可能读到用旧 epoch 封装的新内容。

机器共享方案 A 不在本次修订范围内。批准记录意图，不代表已实现、已部署或真机验收；15 分钟宽限另行实现。

## 账号级个人设备配对

2026-11-01，owner Zixuan Chen（zxch3n）经 E2EE 总调度转达，明确批准 [PR #2182](https://github.com/LodyAI/Lody/pull/2182) 中 revision `65db7d694a6979a0dc8e380815ca033eeddb958c` 的账号级个人设备配对增量。

| 文件                                                                                                                                                | 获批 Git blob                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`specs/e2ee-foundations.md`](https://github.com/LodyAI/Lody/blob/65db7d694a6979a0dc8e380815ca033eeddb958c/specs/e2ee-foundations.md)               | `e43047a7ff7c05de6b256f7fb3a5b43318bfbdde` |
| [`specs/e2ee-foundations.zh.md`](https://github.com/LodyAI/Lody/blob/65db7d694a6979a0dc8e380815ca033eeddb958c/specs/e2ee-foundations.zh.md)         | `01f22d4d70465eb6604452b397eed51f97e6a2d9` |
| [`specs/e2ee/desktop-custody.md`](https://github.com/LodyAI/Lody/blob/65db7d694a6979a0dc8e380815ca033eeddb958c/specs/e2ee/desktop-custody.md)       | `2c37197221c7cdb962592c84f8e107b6f8a26840` |
| [`specs/e2ee/desktop-custody.zh.md`](https://github.com/LodyAI/Lody/blob/65db7d694a6979a0dc8e380815ca033eeddb958c/specs/e2ee/desktop-custody.zh.md) | `c4b74bd01d78df7b1f01a43e114c7435d20c358d` |
| [`specs/e2ee/client-custody.md`](https://github.com/LodyAI/Lody/blob/65db7d694a6979a0dc8e380815ca033eeddb958c/specs/e2ee/client-custody.md)         | `422a7ffd3b25e4ecc4c04849c1746526d77257d8` |
| [`specs/e2ee/client-custody.zh.md`](https://github.com/LodyAI/Lody/blob/65db7d694a6979a0dc8e380815ca033eeddb958c/specs/e2ee/client-custody.zh.md)   | `7f0ce06045376377a086d821f70bfcc8625ca03b` |
| [`specs/e2ee/whitepaper.md`](https://github.com/LodyAI/Lody/blob/65db7d694a6979a0dc8e380815ca033eeddb958c/specs/e2ee/whitepaper.md)                 | `3b15f26057a3b4616d22ca172853faba1e80ece8` |
| [`specs/e2ee/whitepaper.zh.md`](https://github.com/LodyAI/Lody/blob/65db7d694a6979a0dc8e380815ca033eeddb958c/specs/e2ee/whitepaper.zh.md)           | `dddb0b50c023d3b9474d88afccbef4f94e84a83e` |

获批 revision 为 `65db7d69`。之后的提交在这些文件中只改了批准元数据：增量标题和状态行、白皮书的已批准修订行、批准链接，以及随标题改名而变化的章节锚点。它们没有改变已批准的要求。

批准范围包括以下几点：

- **发起请求。** 桌面端和移动端打开没有身份的加密工作区时自动发起请求；网页端需要用户选择"请求访问"。
- **配对字符串。** 一次性的 128 bit 秘密以二维码和 28 字符 Crockford base32 字符串的形式显示。由它派生的请求 HMAC 和批准 HMAC 能发现服务端替换的任何公钥。
- **批准方。** 同一用户的任意活跃个人设备都可以批准；机器和恢复设备不可以。
- **签名之前。**
  - 批准方显示固定警告。
  - 确认步骤指明目标设备，并列出要加入的工作区，每个都可以取消勾选。
  - 设备名称标注为由请求方提供，位置标注为服务器估算的大致位置。
- **批准之后。** 用户的各台设备和账号邮箱都会收到"新设备已加入"通知，并附带撤销入口。
- **幽灵配对的局限。** 威胁模型写明：持有该秘密的一方无法分辨用户被诱导批准的攻击者设备与用户自己的设备。
- **期限与一次性。**
  - 各客户端检查受 MAC 覆盖的请求期限（最长 10 分钟），并持久保存自己已知的终态和用过的秘密。
  - 请求按账号限频。
  - 一次性只在本地状态加上该期限的范围内得到保证。
- **一次批准覆盖整个账号。** 批准即签署各工作区现有的个人设备 `AdmitDevice` 记录；批次写日志、可续传，从不重新签名，不做跨工作区原子操作。
- **手动配对**使用同一个字符串。
- **客户端保管。** 移动端可以自动发起，网页端需要显式确认；任意个人设备都可以批准。

批准只记录意图，不代表已实现、已部署或真机验收。撤销和移除的语义不变。

## 恢复保险库 passkey 解锁与可信锚

2026-11-06，owner Zixuan Chen（zxch3n）通过 E2EE 总调度转达，批准了 [PR #2343](https://github.com/LodyAI/Lody/pull/2343)，head 为 `dec61678ac7b63ebf7768a6986c1844b5f278ce9`，原话是"批准 2343"。获批文件如下：

| 文件                                                                                                                                                    | Git blob                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`specs/e2ee/recovery-vault.md`](https://github.com/LodyAI/Lody/blob/dec61678ac7b63ebf7768a6986c1844b5f278ce9/specs/e2ee/recovery-vault.md)             | `adc4a96b31fc9eef0f0935d9f7a4001ec01145fb` |
| [`specs/e2ee/recovery-vault.zh.md`](https://github.com/LodyAI/Lody/blob/dec61678ac7b63ebf7768a6986c1844b5f278ce9/specs/e2ee/recovery-vault.zh.md)       | `7709935680e641a5537168b5b3c326cdf7fd0af0` |
| [`specs/e2ee/permission-ledger.zh.md`](https://github.com/LodyAI/Lody/blob/dec61678ac7b63ebf7768a6986c1844b5f278ce9/specs/e2ee/permission-ledger.zh.md) | `211f81d09c67da2dd8e78586aab0e7ce2c273948` |
| [`specs/e2ee/whitepaper.md`](https://github.com/LodyAI/Lody/blob/dec61678ac7b63ebf7768a6986c1844b5f278ce9/specs/e2ee/whitepaper.md)                     | `b7834f7922281ca5901cd98740294126fc346647` |
| [`specs/e2ee/whitepaper.zh.md`](https://github.com/LodyAI/Lody/blob/dec61678ac7b63ebf7768a6986c1844b5f278ce9/specs/e2ee/whitepaper.zh.md)               | `83fca1fe454e4c9bc8ef0c6bdd86be302b79ecae` |

之后的提交只改这些文件的批准元数据，并让白皮书的 passkey 表述和 client custody 状态说明与获批的恢复保险库文本一致。

批准范围包括：

- **Passkey 解锁**覆盖 macOS、iPhone 和 Web。RP 主机是 `vault.lody.ai`；Web 是隔离的只解锁界面，晚于 macOS 和 iPhone，也接受恢复文件；该功能要求 iOS 18.4。
- **认证器。** 标准 WebAuthn 加 PRF，不设白名单。注册时没有报告 PRF 就明确拒绝，并引导用户使用恢复文件。Lody 只承诺并测试 iCloud 钥匙串。
- **可信锚。** 通过认证的恢复包里的 genesis 就是锚，用户不用另存任何东西。这取代了独立确认。账本校验和当前代钥承诺校验保留。
- **接受的残余风险。** 恶意运营方或接管 Lody 账号的人，同时骗用户使用攻击者制作的文件或 passkey，可以展示假工作区，但拿不到真实密钥。
- **时机。** 恢复和 passkey 工作并行推进，全部默认关闭。

账本记录和 `formatVersion: 1` 不变。批准只记录意图，不代表已实现、已部署或已通过真机验收。

## 账本用户编号即账户 ID

2026-11-06T19:47:07Z，owner（Lody 账号 `js7cxcb4nzj3dpht6gc9vq8n517xznbm`，消息 `ac3cc04f-be5d-4497-b9e6-e144bc7171f5`）经 E2EE 协调会话（`b12f1597`）转达，批准了 [PR #2365](https://github.com/LodyAI/Lody/pull/2365) 的 head `0d35850c1b4dd1d9ed50ed39f51222ad740c60cb`。原话是“批准 #2365，#2374 用别的办法”。本记录只覆盖 #2365 这部分。批准的文件如下：

| 文件                                                                                                                                                    | Git blob                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`specs/e2ee/permission-ledger.zh.md`](https://github.com/LodyAI/Lody/blob/0d35850c1b4dd1d9ed50ed39f51222ad740c60cb/specs/e2ee/permission-ledger.zh.md) | `30b77b2ccedfdb6ef8a744e4c9565e962f082c68` |
| [`specs/e2ee/whitepaper.md`](https://github.com/LodyAI/Lody/blob/0d35850c1b4dd1d9ed50ed39f51222ad740c60cb/specs/e2ee/whitepaper.md)                     | `ca583dec691023aa7d8aa0a8226335b7422e83b6` |
| [`specs/e2ee/whitepaper.zh.md`](https://github.com/LodyAI/Lody/blob/0d35850c1b4dd1d9ed50ed39f51222ad740c60cb/specs/e2ee/whitepaper.zh.md)               | `ddd77ddccf0b83f6f89f927124cd101fe743a5c1` |

后续提交对这些文件只改批准元数据。

范围是白皮书和 `permission-ledger` 中关于账本用户编号的段落，以及[决定](2026-11-06-e2ee-ledger-user-id.zh.md)里的编码规则：

- **含义。** 账本中稳定的用户编号编码账户 ID。它只指明账户，不证明谁持有签名密钥。
- **编码。** 32 字节：首字节为字符数，其后是小写 Crockford base32 字符，每个 5 位、高位在前，其余位为 0。生产首次开放加密工作区创建时永久冻结。

账本记录及其格式不变。批准只记录意图，不代表实现、部署或真机验收。

## 恢复保险库整库换新

2026-11-06，owner Zixuan Chen（zxch3n）在本人会话 `b12f1597-06ba-4a6e-944c-0395a7d58542`（账号 `js7cxcb4nzj3dpht6gc9vq8n517xznbm`，消息 `01a255e1-459c-4d10-947c-0210f3bcc9b1`）中，于 2026-11-06T18:22:22.775Z 批准了 [PR #2374](https://github.com/LodyAI/Lody/pull/2374)，head 为 `5484218fd5157af1fd1d637865934db852e1cd96`，原话是"批准，16 份"。获批文件如下：

| 文件                                                                                                                                                    | Git blob                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`specs/e2ee/recovery-vault.md`](https://github.com/LodyAI/Lody/blob/5484218fd5157af1fd1d637865934db852e1cd96/specs/e2ee/recovery-vault.md)             | `86953c0ea01020a5db93071e0dc1cf77eb0cb07b` |
| [`specs/e2ee/recovery-vault.zh.md`](https://github.com/LodyAI/Lody/blob/5484218fd5157af1fd1d637865934db852e1cd96/specs/e2ee/recovery-vault.zh.md)       | `3793c3de37195c93c4dcc294e1f89b608e40f758` |
| [`specs/e2ee/whitepaper.md`](https://github.com/LodyAI/Lody/blob/5484218fd5157af1fd1d637865934db852e1cd96/specs/e2ee/whitepaper.md)                     | `e00735bcb501e5de1d95c440baa57b0e0b5c4a09` |
| [`specs/e2ee/whitepaper.zh.md`](https://github.com/LodyAI/Lody/blob/5484218fd5157af1fd1d637865934db852e1cd96/specs/e2ee/whitepaper.zh.md)               | `a6362be095169d3840d81bac7f4f832b364ad5e7` |

收尾提交只改这些文件的批准元数据，并让白皮书同步同一套已批准的整库换新含义，不改变已批准的要求。

批准范围包括：

- **整库换新。** 丢失恢复文件或怀疑文件泄露的用户，从一台仍可用的个人设备整库换新。设备创建并重新打开新文件，对这台设备能处理的每个工作区接纳新 R 并做真实信封测试，通过账本撤销旧 R，然后退役旧保险库并把新保险库设为当前。常规替换仍然需要 V。
- **状态与 16 份上限。** 保险库状态为 `current`、`replacing` 或 `retired`；一个账号最多一个 `current` 和一个 `replacing`。已退役保险库单独计数，上限为 16 份，即 owner 批准的数字；超过后拒绝换新，直到有清理功能。已退役密文仍可读，不移除任何条目。
- **权限。** 退役只需要已登录的 owner 和新保险库已有索引。被盗登录可以预留、放弃和切换，但不能撤销 R、读保险库、伪造恢复包，也不能阻止旧文件打开。恢复不看产品状态，由账本判定。
- **旧文件还能做什么。** 对已换新的工作区，旧文件不能再接纳设备或收到新密钥，但持有旧文件和账号的人在换钥发布前仍能打开其中已有的密钥。换新不会抹掉副本。passkey 需要重新登记。
- **限制。** 流程需要一台能用的个人设备；仍可用的 passkey 可以先恢复一台设备。设备处理不了的工作区会被列出，其旧 R 可能继续有效。账本格式和 `formatVersion: 1` 不变，流程默认关闭，恢复保险库仍不在 MVP 内。批准只记录意图，不代表已实现、已部署或真机验收。

## 后端故障期间的执行新鲜度

2026-11-07，owner Zixuan Chen（zxch3n）在其本人会话 `b12f1597-06ba-4a6e-944c-0395a7d58542` 的消息 `d1041859-25c8-47de-9dbc-96a8bd4e81f1` 中，回答了 [PR #2381](https://github.com/LodyAI/Lody/pull/2381) head `eb0bb74d66905b59be7745ccf2386ce00bc49cfd` 的开放问题。收尾提交把这些答复写入 [`specs/e2ee/execution-freshness-outage.zh.md`](../../../../specs/e2ee/execution-freshness-outage.zh.md)（英文版在该 head 的 blob 为 `4d74fbbdf51b89def934b1f052870f4b68ee4c32`），新增中文版并设置状态。

批准范围如下：

- **窗口。** 读取最新账本没有答复时，机器继续用本地已验证账本判定：所属成员的读取 24 小时，所属成员的执行 4 小时。其他成员的请求保持 15 分钟。
- **故障与拒绝。** 无回复、超时、5xx、429、没有业务错误码的服务端错误算故障。已移除、已撤销、未授权立刻结束窗口。看不懂的回复按拒绝处理。
- **登录过期。** owner 于 2026-11-07 在同一会话修订（消息 `042a6021-a85e-4ce1-973b-a32cf3a92e78`，04:29:38 UTC）：与未授权一样结束窗口，因为服务端把两者报成同一种结果。此前的答复是算故障。
- **可见性。** 窗口使用期间用户能看到提示。
- **后果。** 更长的上限替换同成员读取和执行的 15 分钟最坏情况，如 Spec"上限的变化"一节所述。实现时按本批准把白皮书和基础边界里的 15 分钟段落更新为同一含义。

这里不实现改动，也不批准实现。

## 机器共享

2026-11-02，owner Zixuan Chen（zxch3n）通过合入 [PR #2228](https://github.com/LodyAI/Lody/pull/2228)（merge commit `9b24c65eed8ff5a6459827e0df88acfbd38692d0`）批准[机器共享 Spec](../../../../specs/e2ee/machine-sharing.zh.md)。获批[英文文本](https://github.com/LodyAI/Lody/blob/9b24c65eed8ff5a6459827e0df88acfbd38692d0/specs/e2ee/machine-sharing.md)的 Git blob 为 `37ce21f8e5a3db433b38ac0d2701fcacf6408080`；获批[中文文本](https://github.com/LodyAI/Lody/blob/9b24c65eed8ff5a6459827e0df88acfbd38692d0/specs/e2ee/machine-sharing.zh.md)的 Git blob 为 `c6377547e8dd34c2bc9fbc1d64117cf568aa6d56`。之后仅记录本次批准的修改属于编辑性修改。范围包括 owner 的决定：撤回后不能启动新任务、不能做需要授权的后续动作，但不强制终止已在运行的命令；以及 2026-10-28 接受的风险：服务端持续扣住更新策略时，撤回生效没有严格上限。批准只记录意图，不代表部署或双成员产品验收。
