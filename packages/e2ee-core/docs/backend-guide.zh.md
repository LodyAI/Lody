# 后端指南

[English](backend-guide.md) · [导读](../README.zh.md) · [服务](services.zh.md)

你需要三种远端能力，任何技术栈都可以（HTTP、Convex、Durable Objects、Postgres 服务等）。库从不把密钥或权限托付给这些服务器：它们返回的一切都由客户端重新验证。以下规则的作用，是让服务器无法被用于刷量、重放或隐藏投递状态，并让诚实的服务器行为一致。

| 能力 | 客户端端口 | 服务器需要账本视图吗？ | 合同辅助 |
| --- | --- | --- | --- |
| 账本日志 | `LedgerLog`、`LedgerFeedSource` | 不需要（与内容无关） | — |
| 密钥邮箱 | `KeyMailbox` | **需要**，用于检查资格 | `@lody/e2ee-core/host` |
| 纪元暂存 | `EpochStagingStore` | 不需要 | `@lody/e2ee-core/host` |

`@lody/e2ee-core/host` 与平台无关（不依赖 Node API），可在后端内运行。邮箱规则的完整可运行参考实现是 `@lody/e2ee-core/adapters/node-sqlite` 中的 `makeSqliteKeyMailbox`（`src/adapters/node-sqlite/reference-mailbox-host.ts`）。

**认证。** 每个邮箱和暂存请求都由已认证的设备发起。服务器从会话，或设备入账时绑定的设备访问凭证中得出*主体*（设备签名公钥），从不从请求体中读取。

**签名在哪里验证。** 检查分两层。必需层是每个宿主都必须执行的检查；可选层在此基础上，用 `@lody/e2ee-core/host` 的辅助函数在服务端验证签名。Lody 云端只实现必需层：接受账本记录时验证签名，对信箱和暂存请求只做下面列出的结构检查。接收端总会自己验证签名和密钥承诺，所以省略可选层时，一台设备最多只能在自己的槽位和自己发出的信封上作恶，并且受每个发送者的数量上限约束。

## 1. 账本日志

每个工作区一个只追加的不透明记录序列，服务器无需理解格式。

- **读取**：从创世开始按顺序返回记录，并给出可续读的 offset；可以分页。
- **条件追加**：仅当当前末尾等于期望位置（offset 或记录数）时追加一条记录，绝不无条件追加。完全相同的重复记录必须幂等或被拒绝，不能存两次。
- **持久性**：已确认的追加必须在重启后仍然存在。

Loro / Durable Streams 直接提供这些能力：`@lody/e2ee-core/adapters/loro-streams` 中的适配器使用带 offset CAS 的控制流和 u32be 分帧记录。

## 2. 密钥邮箱

服务器按（工作区、纪元、接收者）保存：已存信封、**修复版本号**、安装报告、被拒帧摘要和修复请求 ID。判断资格需要该工作区当前的已验证账本视图，例如在服务器上运行 `LedgerFeed`。

**`put(id, frame)`**：保存主体撰写的信封。

1. `envelopeRouting(frame)` 必须得到 `sender = 主体` 且属于本工作区。
2. 在当前视图下：发送者是有资格的当前设备（恢复设备不能发送），接收者是当前设备，纪元是当前纪元。可选层：`authenticateEpochEnvelope(view, context, frame)` 另外验证信封签名。
3. `id` 是 16 字节投递 ID（十六进制）。已存在且摘要不同的 `(epoch, sender, id)` 拒绝（`replay`）；完全相同的字节为空操作。
4. 每个发送者、接收者、纪元最多保留 16 个有效（未被拒绝）信封，拒绝第 17 个不同的帧。

**`read(id)`**：返回主体在当前纪元以 `id` 存入的帧，或空。

**`fetch(epoch, cursor, limit ≤ 100)`**：只针对当前纪元，只返回发给主体且未被拒绝的信封，按 `(sender, digest)` 排序。游标为最后一项的 `sender:digest`；只有还有更多行时才返回 `next`。整页必须来自一次一致的读取。

**`status(slot)`**：接收者不是当前设备时为 `Ineligible`；纪元不是当前纪元时为 `Obsolete`；当前版本已有报告时为 `InstallationReported`；存在有效信封时为 `EnvelopeStored`；否则为 `NeedsEnvelope`。同时返回修复版本号。

**`report(report, publication?)`**：解析出的报告在当前视图下以主体为接收者。可选层：`authenticateInstallationReport`，本地发布时再加 `checkLocalPublication`。报告中的版本必须等于槽位当前版本，信封来源必须仍然存在且未被拒绝。记录该版本已报告。

**`repair(slot, id, rejected?)`**：只针对主体自己在当前纪元的槽位。按 `id` 幂等（`rejected` 相同时），否则拒绝（`replay`）。`rejected` 摘要必须对应一个已存信封；将其标记为被拒绝（不再出现在 fetch 中，但保留）。版本号加一并清除其已报告标记。

拒绝映射为 `BackendError` 的 `unauthorized` 或 `conflict`；暂时性故障映射为 `unavailable`。

## 3. 纪元暂存

一次换代完整信封组的不可变存储，键为 `(genesis, epoch, commitment, recordHash)`。使用 DTO `EpochStagedGroupDto` / `EpochStagedGroupKeyDto` 及其 `decode…`/`encode…` 辅助函数。

- **暂存**：主体必须是该组声明的记录签名设备。可选层：验证主体对 `epochStagingRequestSigningBytes({ operation: 'stage', workspaceId, group })` 的签名（`workspaceId` 为你自己的工作区标识），并执行 `checkEpochStageRequest({ genesis, principal, group })`。组不存在时保存；重试必须每个字节一致，否则拒绝。客户端使用暂存组之前，用 `authenticateEpochStagedGroup` 验证。
- **读取**：返回已存组或空。工作区内任何人都可以读取（组是密文）。
- **删除**：只能由记录的签名设备（即主体）发起，请求需注明一个与该组承诺不同的 `occupied` 纪元与承诺。可选层：同时要求请求签名。所有权检查与删除必须原子完成；客户端已验证占用的承诺是真实的。

暂存服务器从不读取或解释账本；在账本包含确切记录之前，已存组没有任何效力。

## 4. 文档内容

存储文档帧的同步服务器应只接纳当前写入者封装的帧。它不解密这些帧（读取方仍会校验 AEAD）。

- 存储已封装帧之前执行 `admitDocument`：已认证的设备具有当前写权限，且帧的纪元已发布、不晚于当前纪元（活跃写入者在换代前封装的帧仍然有效）。
- `@loro-dev/streams-crdt` 0.17 批次使用 `admitStreamsUpdateBatch`：检查分帧、头部 3 以及每一帧的签名与权限。整批接受或整批拒绝，并原样转发原始字节。
- 快照（头部 4）使用 `admitStreamsSnapshot`：此外还需由 `StreamsRecordBoundaryPort` 证明签名中的续读 offset 是不晚于 head 的记录边界（字符串顺序不能作为证明）。

“恰好一次”快照发布日志的单主机参考实现是 `@lody/e2ee-core/adapters/node-sqlite` 中的 `makeSqliteSnapshotPublication`。

## 5. 恢复 vault

对加密 vault 条目和每个 vault 一份索引的不透明存储，使用 `@lody/e2ee-core/host` 中的 `RecoveryVault…` DTO。

- `putImmutable`：条目只存一次；重试必须携带完全相同的字节。
- `readEntry` / `readIndex`：返回已存密文或空。
- `compareAndSwapIndex`：仅当索引仍为 `expected` 的版本与摘要（或不存在），且 `referencedEntryIds` 全部存在时，在同一事务内替换索引；返回 `Committed` 或 `Conflict`。
- `deleteUnreferenced`：仅当索引仍等于 `expectedIndex` 且不引用该条目时删除。

登录控制谁可以取回 vault；后端从不接收解锁秘密、主密钥或恢复私钥。

## 服务器能了解到什么

谁在何时与谁通信、工作区和设备标识符、纪元号、大小与时间。它永远看不到纪元密钥、文档密钥或明文，也无法生成有效的记录、信封或报告。见白皮书的威胁模型：[specs/e2ee/whitepaper.zh.md](../../../specs/e2ee/whitepaper.zh.md)。

## 测试你的后端

让库自己的流程跑在你的后端上：用你的适配器构建客户端 Layer（`E2eeWorkflows` 加你的端口），执行接收、分发、修复和发布。`test/keys/` 中的核心测试展示了值得复现的故障场景：确认丢失、重启后重试、被拒帧、请求过程中的吊销。

## 机器共享策略存储（未接入契约）

可选 cloud-api DTO 精确绑定工作区／genesis、机器与所有者成员实例。每次操作认证设备
凭据并核对当前账本资格；读取可提供给当前合格工作区设备，提交仅限机器所有者的有效
个人设备。保存不透明帧前使用 host 入口的 `admitMachineSharingFrame`，无需解密即可
验证精确机器资源与固定业务签名／AAD 域。这是共享策略必需的准入，与上文信箱的可选
签名检查不同。

插入不可变原文与 CAS 更新 head 必须原子完成。首版为 1、父项／head 为空；后续版本
加一，并引用前一原始密文帧摘要。完整原始密文用 SHA-256 摘要，帧上限 262287 字节。
保存 requestId 与完整原始意图：完全相同的重试即便之后有新版本也返回原收据，同一
requestId 的不同意图要失败；确认冲突不得自动重放。保留原版本供逐版验证，撤回是新
完整策略，不靠删除表示；工作区所有者负责删除清理。head／元数据经客户端验证前不可信，
服务端仍须提供最新 head，支持有界执行新鲜度。这里不启用服务端或传输，见
[待批准 Spec 增量](../../../specs/e2ee-foundations.zh.md#机器共享策略待批准增量)。
