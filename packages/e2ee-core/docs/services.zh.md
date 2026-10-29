# 服务：哪些由你实现，哪些由你选择

[English](services.md) · [导读](../README.zh.md)

库里的 service 分两类：

- **端口**：`@lody/e2ee-core/services` 中的 `Context.Service` 标签。库**需要**它们，由**你**提供：自己实现，或使用现成的适配器。
- **流程**：`@lody/e2ee-core` 中的 `Context.Service` 标签（如 `KeyReceiver`）。库以 Layer **实现**它们，你来调用。测试中可以替换，但生产环境不应自行重写，因为其中承载了协议的安全检查。

端口返回的一切都是**不可信**的：流程会依据签名账本重新验证。故障或恶意的端口可以拖慢进度、降低可用性，但无法授予访问权、注入密钥，也无法让设备回滚到更早的账本。

## 端口一览

| 端口 | 类别 | 如何提供 | 使用者 |
| --- | --- | --- | --- |
| [`LedgerLog`](#ledgerlog) | 后端 | 你的账本服务，或 `streamsLedgerLog`（Loro Streams） | `LedgerSubmission` |
| [`LedgerFeedSource`](#ledgerfeedsource) | 后端 | 你的账本服务，或 `streamsLedgerFeedSource` | 你的同步循环 → `LedgerFeed.accept` |
| [`KeyMailbox`](#keymailbox) | 后端 | 你的邮箱客户端（HTTP、Convex 等）；测试用 `referenceKeyMailbox` | `KeyReceiver`、`KeyRepair`、`KeyDistributor` |
| [`EpochStagingStore`](#epochstagingstore) | 后端 | 你的暂存服务客户端 | `EpochPublisher` |
| [`DeviceIdentity`](#deviceidentity) | 平台 | 你的设备密钥托管（可用 `nativeDeviceSigner`） | 所有密钥流程 |
| [`KeyProtector`](#keyprotector--candidateprotector) | 平台 | 系统级密钥保护；`KeyProtector.fromPromises` 封装原生调用 | `InstalledEpochKeys` |
| [`CandidateProtector`](#keyprotector--candidateprotector) | 平台 | 未发布换代密钥的保护 | `EpochPublisher` |
| [`RecoveryVaultStore`](#recoveryvaultstore) | 后端 | 你的 vault 存储客户端 | `RecoveryVaults` |
| [`WorkspaceScope`](#workspacescope) | 应用 | `Layer.succeed(WorkspaceScope, { genesis })` | 全部 |
| [`LedgerViewSource`](#ledgerviewsource) | 应用 | `LedgerFeed.viewSource`，或你自己的已验证视图 | `VerifiedLedger` |
| [`EpochPublicationSource`](#epochpublicationsource) | 应用 | 查找当前纪元的发布记录 | `KeyDistributor` |
| [`LedgerSync`](#ledgersync) | 应用 | 你的 feed 同步（`LedgerFeedSource` 分页 → `LedgerFeed.accept`，检查点独立选择） | `WorkspaceControl`、`E2eeWorkspace` |
| `RecoveryVaultLocalStore` | 本地存储 | 支持比较并交换的本地键值存储 | `RecoveryVaults` |
| `LedgerPinStore` | 本地存储 | `sqliteLedgerPinStore` | `VerifiedLedger` |
| `LedgerFeedStore` | 本地存储 | `sqliteLedgerFeedStore` | `LedgerFeed` |
| `InstalledKeyStore` | 本地存储 | `sqliteInstalledKeyStore` | `InstalledEpochKeys` |
| `ReceiveJournal` | 本地存储 | `sqliteReceiveJournal` | `KeyReceiver` |
| `RepairJournal` | 本地存储 | `sqliteRepairJournal` | `KeyRepair` |
| `DistributionJournal` | 本地存储 | `sqliteDistributionJournal` | `KeyDistributor` |
| `DeliveryOutbox` | 本地存储 | `sqliteDeliveryOutbox` | `KeyDistributor` |
| `EpochCandidateStore` | 本地存储 | `sqliteEpochCandidateStore` | `EpochPublisher` |
| `SubmissionJournal` | 本地存储 | `sqliteSubmissionJournal` | `LedgerSubmission` |

`sqliteLocalStores({ directory, mode })` 一次提供全部本地存储端口，每个存储一个文件。除非平台没有 Node SQLite，否则直接用它。

## 后端端口

后端规则（*服务器*必须执行的内容）和线上格式见[后端指南](backend-guide.zh.md)与 `@lody/e2ee-core/host`。本节说明*客户端*合同。

### LedgerLog

保存工作区签名记录的只追加日志，是协议在权限上唯一依赖的远端写入。

- `read(anchor)` 返回从创世开始的全部记录，以及日志自称的检查点。库会重新验证全部内容。
- `appendCas(anchor, expected, record)` **仅当**日志仍以 `expected` 结尾时才追加，绝不能无条件追加。同样的字节追加两次必须是幂等的或被拒绝。
- 失败为 `LedgerLogError`。任何失败之后库都会回读以确认结果，因此响应丢失是安全的。

### LedgerFeedSource

对同一日志的分页读取，用于保持本地 feed 最新：`readAfter(offset)` 返回不可信的 `LedgerReadPage`。offset 是不透明标记，`'-1'` 表示从创世开始。`LedgerFeed.accept(page, checkpoint)` 在存储任何内容之前验证每一页。

### KeyMailbox

在设备之间转发纪元密钥信封，以及安装报告和修复请求。适配器**把每次调用绑定到已认证的设备**；请求体永远不能选择发送者或接收者。

| 方法 | 含义 |
| --- | --- |
| `status(slot)` | 某个槽位的投递状态（`NeedsEnvelope`、`EnvelopeStored` 等）和修复版本；仅作调度提示 |
| `fetch(epoch, cursor, limit)` | 发往本设备的一页信封 |
| `put(id, frame)` / `read(id)` | 存入 / 回读本设备撰写的信封 |
| `report(report, publication?)` | 上传签名的安装报告 |
| `repair(slot, id, rejected?)` | 请求发送者重新投递；可选地拒绝某个帧 |

失败为 `BackendError`，`reason` 为 `unavailable`（稍后重试）、`unauthorized`、`invalid-response` 或 `conflict`。投递只把 `unavailable` 视为暂时性故障，其他原因按失败报告。

### EpochStagingStore

在追加换代记录**之前**保存该次换代的完整信封组，这样即使发布者在提交后立刻消失，新密钥仍可获取。组在其键下不可变，只有记录的签名者可以暂存或删除；在账本包含其确切记录之前，组没有任何效力。

### RecoveryVaultStore

保存加密的恢复 vault：不可变条目，加上通过比较并交换替换的索引。它从不接收解锁秘密、vault 主密钥或恢复私钥。线上格式在 `@lody/e2ee-core/host`；见[后端指南](backend-guide.zh.md#5-恢复-vault)。

## 平台端口

### DeviceIdentity

本设备的 `{ signer, encryptionKeyPair }`。`signer.sign` 必须返回有效的 Ed25519 签名；库在使用前会验证收到的每个签名，错误的签名器只会导致失败，不会产生坏记录。私钥始终由你托管。`nativeDeviceSigner(publicKey, cryptoKey)` 可由 WebCrypto Ed25519 密钥构造签名器。

### KeyProtector / CandidateProtector

`protect(body)` 与 `unprotect(blob)` 对整个 body 做认证加密；库把用途、工作区、设备、纪元和承诺都绑定在 body *内部*，保护器无需理解格式。

- 原生工作结束前调用不能返回：调用返回后库就会擦除缓冲区。`KeyProtector.fromPromises(native)` 会让每个 Promise 调用不可中断。
- `KeyProtector` 保护**已安装**的密钥（账本已承诺）；`CandidateProtector` 保护**未发布**的换代密钥。二者刻意分开：用什么保护尚未发布的密钥是一项单独的决定。两者可以由同一种原生机制实现，但必须在组合中显式表明。
- 保护器总能读取它保护的内容：它是宿主平台的信任边界，而不是对被攻破宿主的隔离。
- 桌面端：`apps/electron/src/main/e2ee-custody.mts` 中的 `desktopE2eePorts(custody, device)` 基于操作系统包装的密钥（Electron `safeStorage`）提供两个保护器和 `DeviceIdentity`。

### ClientKeyCustody / ClientInstallationStore

这两个可选端口冻结 [已批准的 Web/移动端保管 Spec](../../../specs/e2ee/client-custody.zh.md)，
不启用产品 host。安装 store 先捕获 ClientCustodyScope（账号、工作区、独立钉住的
genesis），再读出保留的设备与安装 ID。custody 捕获完整 ClientCustodyBinding，
使用前必须认证该绑定。回执按一个 scope 只有一个位置，因此其他标签
持不同安装 ID 会冲突，不能生成第二个身份。store 原子推进 revision 并保存第一份
包装身份原件，不执行 crypto，也不授予批准。普通 compareAndSet 不能换身份。验证新桌面
批准并排空旧身份后，replace 核对完整退休绑定/revision，在一个事务归档旧回执并以
revision+1 选择 protected 新身份。readRetired 读取精确旧回执；不删除或重标旧 journal、
pin 或包装。prepareReplacement 只校验/复制纯写入计划，事务、读回、归档唯一性及
精确重试核对仍归适配器。切换当前指针前，待配对 journal 保留包装候选和精确审批请求。

ClientKeyCustody 仅提供 status/create/wrap/unwrap/delete。status 不创建密钥；create
在持久化准备和显式配对同意后执行，不替换未知的保留状态。本地认证包装绑定版本、
完整 scope 和封闭用途。Web 持久化不可导出 AES-GCM KEK；原生客户端将该能力放在
设备绑定保护器内。实际原生操作结束前，不释放借入缓冲或单写者所有权。缺保护拒开
加密空间；丢失或不确定保留原件，只能精确核对或桌面重新审批后显式替换，不能清空
位置或另开命名空间。scope 关闭、普通清
缓存与 logout 保留身份；仅显式限定 hard reset 或排空后的已认证终端移除可删除。

既有 identity、installed/candidate protector、账本/提交 store 及密钥/快照 journal
保留原责任。本合同不新增密钥导出、文件访问或验签钩子。浏览器 crypto/IDB 适配器与
可移植 host/runtime 消费者须另行实现和平台验收，既有桌面/CLI API 不变。

共享本地包装 v1 字节及全部 CLIENT_KEY_PURPOSES 由
[test/client-custody-vector.json](../test/client-custody-vector.json)固定，使用独立 CBOR
生成器、锁定的 DAG-CBOR 库、WebCrypto 与 noble 核对。它们是合成互通检查，不是原生
保管或 IDB 验收。

## 应用端口

### WorkspaceScope

`{ genesis }`：本次组合服务的工作区。所有存储和流程都绑定到它，为其他工作区创建的存储会被拒绝。

### LedgerViewSource

`current()` 返回应用持有的最新*真实*账本视图，通常是 `LedgerFeed.viewSource`。`VerifiedLedger` 会检查每个视图：由库验证、属于本工作区、延续本设备此前看到的内容，并包含持久化的钉。

预期的 feed、存储或传输失败必须包装成 `LedgerViewSourceError({ cause })`；
`LedgerFeed.viewSource` 已完成这一步。`VerifiedLedger` 返回 `reason: 'source'`，
不会推进持久化检查点。缺陷和中断仍保留在 Effect 的 Cause 通道中，不能转成可用性错误，也不要向用户显示原始 cause。

### EpochPublicationSource

`current(view)` 返回发布当前纪元的那条记录的原始字节（纪元 0 为创世记录），或 `null`。分发器只用它记录本设备自己的发布，并会先验证。通常是对本地 feed 的逆向扫描。

### LedgerSync

`refresh()` 独立选择目标检查点，并把本地 feed 读到该检查点；`current()` 返回已存状态。`WorkspaceControl` 与 `E2eeWorkspace` 使用它，工作区由它派生 `LedgerViewSource`。

## 本地存储端口

每个本地存储的合同形状相同（完整方法列表见各端口的 JSDoc）：

- 每个方法是**一个原子步骤**。写入会在同一事务内读回校验，并检查文件仍绑定于本工作区和设备；任何不一致都会回滚，并以 `corrupt` 失败。
- 错误为 `LocalStoreError`，`reason` 为：`storage`（I/O，重试可能有效）、`corrupt`、`closed`（所属 Scope 已关闭）、`conflict`（前置条件不再成立）、`capacity`（有界存储已满）、`missing`。
- SQLite 初始化和 pin 读取把确定的文件损坏归为 `corrupt`，busy、locked、权限错误仍为 `storage`；读取失败不得重置 pin。
- 存储不做任何决定：读出的行由对应流程重新校验，任何已存字节都不授予权限。
- 日志会保留原始内容和结果，直到应用确认；不会自动删除。

如需存到别处（IndexedDB、移动端数据库等），在该存储上以相同的原子性实现这些端口；`src/adapters/node-sqlite` 中的 SQLite 适配器是参考实现。

## 可以替换的内部部件

有些部件不是端口，但设计上允许在特定场景替换：

| 部件 | 何时替换 | 方式 |
| --- | --- | --- |
| `LedgerFeed` | 你已维护一份经过验证的账本 | 用你自己的 `LedgerViewSource` 代替 `LedgerFeed.viewSource` |
| `E2eeWorkflows` | 只需要部分流程 | 只组合需要的 `X.layer` |
| 任意流程 | 对其使用方做单元测试 | `Layer.succeed(KeyReceiver, KeyReceiver.of({...}))` |
| `referenceKeyMailbox` | 测试与 Lab | 在进程内把 `makeSqliteKeyMailbox` 宿主绑定到某个设备 |

`@lody/e2ee-core/internal` 下的一切（准入门、封装器、测试辅助）都**仅供内部使用**：不稳定，只服务本仓库测试与 Lab。

`LedgerFeedStore.rebase` 比对完整的预期末尾，在同一事务内替换起点和长度、删除
已覆盖记录，并写入和读回核对新末尾。末尾不符返回 conflict，不修改数据。
