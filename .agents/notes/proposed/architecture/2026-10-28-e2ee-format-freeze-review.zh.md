# E2EE 冻结前格式审查

Status: proposed
Translation: current
PR: [#2026](https://github.com/LodyAI/Lody/pull/2026)

[English](2026-10-28-e2ee-format-freeze-review.md)

## 摘要

根据 owner 于 2026-10-28 的决定，账本 v1 记录格式可按现状冻结。恢复设备 tag 4 与 `possess/v2` 不变，可信锚独立确认，generation 和账本材料存入 `formatVersion: 1` 的加密恢复包；tag 9、capability 1 和 tag 10 也已批准。这是格式结论，不代表生产开放或恢复保险库验收；保险库仍为 draft，且不在 MVP 内。

## 决定与剩余工作

Owner 接受现有恢复记录与证明、genesis 不变、私有 generation 和可信材料，以及独立确认可信锚、实际解密当前代信封并核对承诺的验收条件。[批准记录](../../implemented/architecture/2026-10-28-e2ee-spec-approval.zh.md)由 [#2032](https://github.com/LodyAI/Lody/pull/2032) 更新。[恢复保险库 Spec](../../../../specs/e2ee/recovery-vault.zh.md)记录已批准边界，整体仍为 draft。自撤和登记顺序不需要改变 tag 4/5/7 字节。离线导出、平台保管和账号政策仍单独决定；生产仍须先经真机验收和白名单灰度。

## 恢复格式与理由

**已批准的边界：保留现有 tag 4 和 `possess/v2` 字节，不改 genesis 或账本记录字段。**包版本和验收条件已批准，但它们的实现和保险库整体仍为 draft。记录未重复的字段从之前已验证状态取得：

```text
记录 = CBOR([ [previousHash32, 批准用个人设备Ed25519公钥32,
                [4, 2, R的Ed25519公钥32, R的X25519公钥32, R持钥签名64]],
               个人设备批准签名64 ])
R持钥签名 = Ed25519_R("lody-e2ee/possess/v2\0" ||
  CBOR([genesisHash32, membershipId16, R的Ed25519公钥32, R的X25519公钥32, 2]))
个人设备批准签名 = Ed25519_D("lody-e2ee/sig/v1\0" || CBOR(记录正文))
```

沿用规范有界账本 CBOR、8192 字节记录及 256 字节字节串上限。`previousHash` 绑定准确位置和原链；有效个人设备的签名表达用户批准，`membershipId` 从紧邻此前的已验证签发者状态取得，不能相信服务端自报。R 的证明绑定已固定 genesis、成员实例、两把 R 公钥和 kind 2，阻止跨工作区/成员/密钥替换；外层签名和链绑定批准与前序记录。签名私钥证明**不能证明 X25519 私钥持有**。标记恢复可用前须导入两把私钥、推导并比对两把公钥、解密发给 R 的当前代新信封并核对账本代钥承诺；这是流程验收条件，不是新增账本证明。账本验证对 Ed25519 使用严格校验；X25519 字段目前只要求 32 字节且非全零，并不拒绝所有低阶输入。成功 HPKE 解密和密钥对比是独立的验收检查，不代表账本解析更严格。撤销不使旧签名记录失效。

| 必要信息 | 精确位置与理由 | 对现有字节的改动 |
| --- | --- | --- |
| Genesis 和成员实例 | R 证明中的 `genesisHash32`、`membershipId16` 分别来自已固定 genesis 和签发者此前的已验证成员身份，防止证明被复制到其他工作区或重新加入的成员实例。 | 无；tag 4 不重复这两项。 |
| R 签名/加密公钥及 kind | 两把 32 字节公钥和 `kind=2` 同时在 tag 4 和证明中。要求 R 的签名证明与同成员有效个人设备的批准。 | 无。签名绑定所声明的加密公钥，但不能证明对应私钥持有。 |
| 恢复 generation | **仅在私有恢复库索引/包内**：`generation` 为非负安全整数，初次为 0；替换该工作区/成员的 R 时生成新密钥对，并在索引 CAS 下递增原索引 generation。它是并发与版本标记，不是 epoch、账本权限或密钥重用例外。并发首次设置采用胜出的包；不同替换候选冲突，不静默合并。 | 现有[恢复包](../../../../packages/e2ee-core/src/internal/recovery/vault.ts)已有 generation；tag 4 和证明无需新增。溢出则失败、新成员实例重新从 0 开始属于尚待完成的保险库设计。 |
| 可信锚和账本材料来源 | 在**加密包**中保存规范 CBOR 对象字段：`genesis`（64 位小写 hex）、`membershipId`（32 位小写 hex）、`generation`、`signingPublic`/`encryptionPublic`（各 32 字节 bstr）、`signingPrivate`/`encryptionPrivate`（PKCS#8 DER bstr，32–256 字节）和 `trust: {source, genesisRecord, head, length}`。`source` 是有界非空定位符/标签，不是权威；`genesisRecord` 是不超过 8192 字节的原始规范签名记录，`head` 为 64 位小写 hex，`length` 为正安全整数。加密索引绑定 genesis/成员/generation、不可变 entry ID 和密文摘要。包及索引均上限 256 KiB，拒绝非规范 CBOR。[host DTO](../../../../packages/e2ee-core/src/host/recovery-vault.ts) 只携带 entry ID、revision 和不透明密文，不携带这些身份或信任明文字段。 | 实现已有这些字段；账本不变。启用恢复前，在恢复 Spec 和实现中新增**`formatVersion: 1` 包字段**、拒绝其他版本，并明确 PKCS#8 算法/DER 校验和 source 的解释。拒绝不支持的版本，不静默改写原件。 |

**可信启动：**包必须来自用户恢复能力能认证、先前已验证设置选择的恢复库条目；其中 genesis 须等于独立固定或先前认证的工作区身份。验证 `genesisRecord` 哈希等于固定 genesis，且其签名有效。从该 genesis 验证完整账本至另行核实的终点，并证明保存的 head/length 是其前缀。保存的 head/length 只有确实来自已验证视图时才可作为防回退检查点；包加密及 `source` 字符串不证明来源，也不证明全局最新。无法独立确认锚或终点时应停止并要求可信确认，不能把服务端 URL、自签 genesis 或服务端新响应提升为信任根。服务端仍可能隐瞒更新；新鲜度/可用性属于独立假设。现有[工作区流程](../../../../packages/e2ee-core/src/internal/recovery/workspace.ts)用调用者提供的 genesis 校验 genesis 记录，但尚未证明包中的 source/head/length 独立建立信任或新鲜度。

**为何不把锚写进 genesis 或 tag 4：**genesis 不能证明自己被正确选择；服务定位符和已保存检查点可独立于成员身份变化。将它们写进永久公开账本会暴露或锁死可变恢复存储，却不能证明其可信。建议在加密包内保存签名 genesis 和先前已验证检查点及其独立核实的来源；另用认证过的查询定位其余记录。若 owner 要求公开可验证的恢复 generation 或公开承诺的锚来源，这是另一项需求，须冻结前明确批准新记录格式并重新生成向量；不能从私有恢复库计数器推断该要求。

**顺序与自撤：**生成 R，上传不可变私有包并回读解密；经索引 CAS 选择胜出者；有效个人设备 D 用 R 证明签署 tag 4，持久保存原始记录和位置，提交并对账，然后验证登记；最后发布、读取、解密当前代信封并核对承诺，才标记可恢复。普通替换先验证新 R 再撤旧；泄漏时可先撤旧。若 D 自撤，用 tag 5 的原始签名字节对账，之后的 tag 7 换代须由其他有资格的个人设备签署；R 可以登记新个人设备，但不能换代。若已无合格管理员，不能承诺能换代。撤销设置提示性的 rotation-required，不阻断诚实客户端封装内容。这些是顺序和可用性规则，不改变现有 tag 4/5/7 编码；不承诺跨存储原子性。

**冻结前建议补充的账本固定向量：**独立固定恢复 tag 4 字节、`possess/v2` 签名字节与签名、记录哈希和重放状态；补充更改 genesis、成员、kind、R 签名/加密公钥或批准者，以及非规范或截断记录的负向量。保留现有 tag 9/10 和未知能力向量；冻结后不得重新生成已冻结向量。这些是建议补充的验证，不代表本次已运行新测试。
## 格式盘点与处理建议

“向量”指固定字节预期，而非只有往返测试。“当前版本”遵循[格式兼容性](../../../../specs/e2ee-foundations.md#format-compatibility)；已提交证据仍必须保留。

| 格式和定义 | 版本、域与限制 | 向量和未知输入 | 冻结建议 |
| --- | --- | --- | --- |
| [账本记录](../../../../packages/e2ee-core/src/internal/ledger/records.ts)、[CBOR](../../../../packages/e2ee-core/src/internal/foundation/cbor.ts) | Genesis v1；tag 1 成员登记、3 角色、4 设备、5 撤设备、6 转移 Owner、7 代钥、8 原子移除并换代、9 能力、10 移除。tag 2 已废止。域为 `lody-e2ee/{sig/v1,rec/v1,join/v1,possess/v2}\0`；规范有界 CBOR，记录 8192 字节、字节串 256 字节、深度 8、数组 32；tag 9 为 1–16 个严格递增的非零 u32。 | [独立向量及生成器](../../../../packages/e2ee-core/test/generate-ledger-v1-vector.py)覆盖 genesis 和所有接受的 tag，包括 9/10 与机器替换。未知 genesis 版本和操作失败；真实但不支持的能力声明停止于 `upgrade-required`。冻结后不再是 current-only。 | **可按现状冻结**；永久保留已接受的字节、哈希和重放结果。 |
| [本地保留状态与签名快照](../../../../packages/e2ee-core/src/internal/ledger/snapshot-codec.ts) | 状态、信封、正文 v4；`snapshot/v1`、`head-attest/v1`、`snapshot-digest/v4`；上限 2 MiB。 | 行为测试覆盖签名快照和恢复；未发现独立固定 v4 字节向量。其他版本返回 `unknown-version`。仅当前版本；只有完整原始账本存在时才可重建。 | **可推迟**独立向量与 v4 演进；不得改写不支持的已保留证据。 |
| [内容帧](../../../../packages/e2ee-core/src/internal/foundation/content-format.ts) | v0，`lody-content-*/v0\0`；purpose 7/8/9 为 presence/请求/响应。头 39 + nonce 24 + tag 16 + 签名 64 = 143 字节；通用明文上限 16 MiB。 | [独立实时向量](../../../../packages/e2ee-core/test/realtime-content-vector.json)覆盖 7/8/9；不支持的版本失败。仅当前版本。purpose 7 保留，MVP presence 不使用它。 | **可独立于账本推迟**；保留已保存密文；改变格式前明确决定未来如何读取。 |
| [RPC 资源](../../../../packages/loro-streams-rpc/src/e2ee-resource.ts)、[帧正文](../../../../packages/loro-streams-rpc/src/e2ee-wire.ts) | `rpc:` 加原始 1–256 UTF-8 字节 machineId 的无填充规范 base64url；正文 v0，帧上限 1 MiB，含 143 字节开销。 | [独立正文向量](../../../../packages/loro-streams-rpc/tests/fixtures/e2ee-wire-v0.json)；编码器输出规范资源，未发现资源解码器。未知正文版本/类型拒绝。仅当前版本。 | **可推迟**，另补固定资源边界向量，并在解析资源处明确接收端校验。 |
| [执行 journal](../../../../apps/cli/src/lib/e2ee/realtime-journal.ts) | SQLite `user_version=3`，控制库 v1；保存原始请求/响应证据与防重复执行记录。 | 有崩溃/重开行为测试，未发现可移植固定数据库向量。未知 schema 关闭；按[恢复决定](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.zh.md)显式重置时保留归档证据和防重复记录。仅当前版本。 | **可推迟**；不得自动迁移、删除或重新执行保留工作。 |
| [机器共享](../../../../packages/e2ee-core/src/internal/machine-sharing.ts) | 规范策略 v2，`lody-e2ee/machine-sharing/v2\0`；资源 `machine-access:<无填充 machineId>:<成员 hex>:<generation hex>`。generation 为连续替换链的初始公钥；策略上限 256 KiB。 | 有行为测试，未发现独立固定 v2 字节；其他版本返回 `unsupported-policy-version`。仅当前版本；generation 须由账本证明。 | **可推迟**；策略不属于账本操作。将策略字节视为稳定之前补签名帧和 generation 向量。 |
| [附件](../../../../packages/shared/src/encrypted-attachment.ts) | 清单 v1；AES-GCM 4 MiB 分块、索引 nonce，JSON 元组 AAD `lody-encrypted-attachment-v1`；最多 100 MiB/25 块。 | 有行为测试，未发现独立固定分块/AAD 向量。未知清单版本不通过 schema。仅当前版本的规则不允许丢失已保存附件。 | **可推迟**；演进前固定 JSON/Unicode 与边界向量。 |
| [schedule 授权声明](../../../../packages/shared/src/schedule-authorization.ts)、[指纹](../../../../packages/shared/src/schedule-registry.ts) | Loro map 保存 `kind`、指纹和可选 manual key；指纹是递归排序 JSON 的 SHA-256。声明和指纹没有显式版本或域。 | 有授权行为测试，未发现独立固定指纹向量。未知 kind 被跳过；没有显式未知版本分支。保存在认证内容中；仅当前版本。 | **演进已保存 schedule 前需设计**：增加明确版本/域，定义旧声明验证且不使保留证据失效；这本身不是账本 v1 冻结阻塞。 |
| 公开内容分享 | [白皮书](../../../../specs/e2ee/whitepaper.md)要求明确发布副本；本审查未发现独立 E2EE 分享确认的持久或线格式。 | 未发现向量或版本。这不代表已审查全部产品分享实现。 | **可推迟**，未来格式须另行版本化和审查。机器共享见上表。 |
| [Node 密钥保管](../../../../packages/e2ee-core/src/adapters/node-custody/index.ts) | `desktop-custody/v1\0`、长度前缀 AAD、nonce 和密文；设备、凭证、已安装和候选代钥有不同 v1 purpose 域；另有 OS 包装和 rewrap journal。 | 有行为测试，未发现独立固定 blob 向量。错误域/长度返回 `corrupt`；不导入旧格式。仅当前版本，须保留原始密钥文件。 | **可推迟**；改变格式前补固定 blob/AAD 和中断 rewrap 向量。 |

## 向量和域审查

冻结后保持现有独立账本生成器和提交字节不变。建议补充的向量仅限上文列出的恢复记录及负例；已有 tag 9/10 向量保持不变。
本次检查的上述账本、内容、策略、附件和 custody 域使用不同字面命名空间，未发现碰撞。schedule 哈希没有专用域和显式版本，未来语义演进存在歧义；这并不是已证明的跨协议碰撞。RPC 编码器产生无填充 base64url；本审查未证明存在接受填充别名的独立解析器。检查的账本 codec 未证实存在未固定长度上限或接受非规范编码的问题。

## 证据与限制

重复记录检查发现现有账本、紧凑状态、机器共享、附件和 journal Note 分别拥有各自机制；本提案不取代它们。本次检查了源码和固定样例，未检查部署后端、真机行为、全部本地格式，也未形式化证明所有域互不相交。本文不批准任何 Spec，也不授权生产开放。已批准的格式边界不等于实现或生产验收；本次不实施代码改动。
