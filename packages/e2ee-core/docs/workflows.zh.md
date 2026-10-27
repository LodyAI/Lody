# 流程

[English](workflows.md) · [导读](../README.zh.md) · [服务](services.zh.md)

按应用接触的先后顺序说明每个流程的行为。每节列出该流程需要的端口；`E2eeWorkflows` 会把它们全部组合起来。

## VerifiedLedger

_需要 `WorkspaceScope`、`LedgerViewSource`、`LedgerPinStore`。_

唯一的回滚与分叉守卫。`current()` 获取视图后，只有同时满足以下条件才接受：

1. 是真实视图（由本库验证器构造）。
2. 属于本工作区。
3. 延续本进程见过的最新视图。
4. 包含持久化的钉。

然后推进钉；检查点不变时不写入。钉写入失败时，较新的视图仍记在内存中，旧视图继续被拒绝。`ensureCurrent(view)` 对较早获得的视图重复进程内检查。新鲜度只相对于本设备自己的历史；全局新鲜度仍依赖日志不隐藏记录。

## LedgerFeed

_需要 `WorkspaceScope`、`LedgerFeedStore`。选项：起点、期望检查点、预算。_

本地已验证的账本副本。起点是创世记录，或经过背书的快照（每次打开都要重新提供 `trust`）。打开时重新验证所有已存字节，直到独立提供的 `expected` 检查点。`accept(page, checkpoint)` 验证一页 `LedgerFeedSource` 数据（拒绝重复、过旧或回退的页面）并原子追加；内存中的视图只在写入提交后才改变。预算超限时失败关闭，从不删除已提交历史。`LedgerFeed.viewSource` 把 feed 转为 `LedgerViewSource`。

## LedgerSubmission

_需要 `WorkspaceScope`、`SubmissionJournal`、`LedgerLog`。_

每个工作区一次只提交一条签名记录，且恰好一次：

```text
submit(record):  journal.prepare(原始字节) → 在父记录处 appendCas → 回读
                 → Committed（这些字节已在日志中）| Conflict（父位置被其他
                   记录占用）| unconfirmed（稍后用 resume 重试）
resume():        继续已保存的原始字节；从不重新签名
acknowledge(r):  释放已完成的结果
```

签名设备在此期间被吊销时，记录以 `Conflict` 结束，不会重新签名。日志记住观察到的最新检查点，拒绝已回滚的日志。

## InstalledEpochKeys 与 InstalledEpochHistory

_需要 `WorkspaceScope`、`DeviceIdentity`、`VerifiedLedger`、`KeyProtector`、`InstalledKeyStore`。_

本地密钥材料的唯一所有者。`saveAndReload(epoch, key)` 按以下顺序执行：

1. 对照账本承诺检查密钥，用 `KeyProtector` 封装。封装的 body 为 `purpose ‖ genesis ‖ device ‖ epoch ‖ commitment ‖ key`。
2. 验证新的密钥块可以打开。
3. 存储；先写入的密钥块胜出。
4. 只有*已存储*的密钥块能重新打开并匹配，才算成功。

无法读取的已存密钥块，只能被已成功打开并匹配的新块替换。`read(epoch)` 返回由调用方释放的全新不透明密钥。两者在每个异步步骤之后都会重新确认本设备仍是有效成员。

`InstalledEpochHistory.read(epoch)` 返回已安装的密钥。只有该密钥确实缺失时，才从最新已安装的密钥出发验证整条签名历史包链，保存恢复出的旧密钥，并返回所请求的那个。损坏、权限和存储失败从不被“恢复”。这只恢复已安装的历史，不是 vault。

## KeyReceiver

_需要 `WorkspaceScope`、`DeviceIdentity`、`VerifiedLedger`、`InstalledEpochKeys`、`KeyMailbox`、`ReceiveJournal`。_

安装本设备收到的密钥并报告安装结果。

```text
receive(sender, frame)        验证签名、发送者资格和帧
  → 保存任务（Install）       任何网络步骤之前先持久化原始帧
  → HPKE 解封 + 承诺校验       每个待安装任务都会重复这些检查
  → InstalledEpochKeys.saveAndReload
  → 签名报告并排队（Report）
flushReports()                发送已排队的原始报告（Reported）
resume()                      重启后完成被中断的安装
fetchAndInstall(cursor)       邮箱一页 → 逐个 receive
receiveStagedGroup(group)     从已提交换代的暂存组中安装
recordLocalInstallation(rec)  报告本设备自己的发布
results() / acknowledge(id)   已结束任务保留到确认为止
```

- 报告是签名的安装声明，不是托管证明。
- `fetchAndInstall` 在写入任何内容前复制并校验整页；任一安装失败时不返回 `next`。`MailboxInstallError` 指明失败的帧（发送者、`frameDigest`），由应用决定是否请求修复。
- 只有真实的账本变化才把任务结束为 `Obsolete` 或 `Revoked`。

## KeyRepair

_需要 `WorkspaceScope`、`DeviceIdentity`、`VerifiedLedger`、`KeyMailbox`、`RepairJournal`。_

当本设备无法安装当前密钥时，请求发送者重新投递。`enqueue(id, rejectedDigest?)` 在发送任何内容之前，把调用方选定的稳定 ID 与当前纪元及可选的被拒帧持久绑定；以不同字段复用同一 ID 会以 `replay` 失败。`flush` 发送待处理请求（邮箱按 ID 去重），并以 `Repaired`、`Obsolete` 或 `Revoked` 结束。`Repaired` 只记录请求成功，绝不表示已安装。

## KeyDistributor

_需要接收者的全部端口，外加 `KeyReceiver`、`DeliveryOutbox`、`DistributionJournal`、`EpochPublicationSource`。_

确保每台当前设备都能拿到当前密钥。

```text
reconcileCurrentEpoch()     接收者来自已验证账本（从不来自服务器）
                            每个（接收者，邮箱版本）一个任务
resumePendingDeliveries()   使用 outbox 中的原始密文，或只加密一次并保存
                            put + 精确回读 → Observed
results() / acknowledge()   已完成任务保留到确认为止
```

每个接收者在每个纪元的第一份密文永久保留，并在每次重试时重新发送；版本号变化只触发重试，从不产生新密文。恢复设备可以接收密钥，但从不发送。`Observed` 表示邮箱返回了完全相同的字节，不表示接收者已安装。日志满时新任务以 `task-limit` 失败；确认会释放容量，但不删除历史。

## EpochPublisher

_需要 `WorkspaceScope`、`DeviceIdentity`、`VerifiedLedger`、`InstalledEpochKeys`、`CandidateProtector`、`EpochStagingStore`、`LedgerSubmission`、`EpochCandidateStore`。_

换代纪元密钥（`publish`），或在一条签名记录中移除成员并换代（`publishRemoving`，仅 owner）。

```text
生成密钥 → 封装历史包 → 签名记录 → 为每台设备生成信封
→ 保存候选（由 CandidateProtector 保护）并回读
→ 暂存完整信封组，并精确回读
→ LedgerSubmission.submit
→ Committed：经 InstalledEpochKeys 安装 | Conflict：丢弃候选密钥
```

`resume` 在崩溃后完成同一个候选，不再签名。`cleanupStaged` 在该纪元被不同承诺占用后删除本设备的暂存组。`acknowledge` 释放已完成的结果。只有 owner 或 admin 的个人设备可以换代。绕过暂存直接追加的管理者可以扣留密钥：这是已知的可用性限制，不破坏机密性。

## WorkspaceControl 与密钥轮次

`WorkspaceControl`（_需要 `DeviceIdentity`、`LedgerSubmission`、`LedgerSync`_）在刚刷新的视图上签名普通命令（接纳成员或设备、设置角色、吊销、转移 owner），每条只提交一次。存在待处理或未确认的提交时禁止新的签名；只有本地 feed 已包含提交时观察到的检查点，结果才会被确认。

`runWorkspaceKeyRound(limit, cursors)`（_需要 `KeyRepair`、`KeyReceiver`、`KeyDistributor`_）是一轮有限的维护：发送修复、恢复安装、获取一页邮箱、发送报告、协调并投递、再次发送报告、列出结果。每个队列各自保留游标提示。

## E2eeWorkspace

以上一切之上的应用门面。`WorkspacePlatform` 为每个工作区提供端口 Layer（`WorkspacePorts`）、每个资源的原生文档状态，以及可选的恢复配置。`E2eeWorkspace.open()` 在工作区 Scope 中构建 `E2eeWorkflows` 与 `WorkspaceControl`，返回一个句柄：账本命令、换代与移除、密钥轮次、文档（`document(resource, model)` 返回 Streams 绑定和原生状态）、结果与确认、恢复。

句柄上会改变状态的调用是串行的。`close()` 停止平台工作、等待进行中的操作，然后释放流程与存储。`E2eeWorkspace.restoreFromRecovery` 先执行恢复设备的恢复流程，再打开新个人设备的工作区并安装恢复出的密钥。

## 恢复

`RecoveryVaults`（_需要 `RecoveryVaultStore`、`RecoveryVaultLocalStore`_）创建并解锁 vault-v1：离线保存的恢复文件，或 passkey PRF。`makeWorkspaceRecovery` 维护某个工作区的恢复条目（设置、测试、替换、跳过）并执行恢复：恢复设备接纳新的个人设备，再由该设备安装所有纪元密钥。方案见白皮书的备份与恢复一节及[恢复 vault](../../../specs/e2ee/recovery-vault.zh.md)。

## 文档

文档内容使用 content v0：签名头部，以由纪元密钥派生的文档密钥做 XChaCha20-Poly1305 加密，AAD 绑定用途。

- **Loro / streams-crdt**：`streamsDocumentBinding({ resource, model, writeEpoch })`（`@lody/e2ee-core/adapters/loro-streams`）是 `@loro-dev/streams-crdt` 文档的载荷保护绑定。它封装更新（头部 3）与快照（头部 4，续读 offset 位于签名头部内），并打开读到的内容。签名器、账本视图与密钥分别取自 `DeviceIdentity`、`VerifiedLedger` 与 `InstalledEpochHistory`。
- **其他传输**：`sealDocument`、`openDocument` 与 `authenticateDocument`（`/protocol`）接收文档密钥、签名器和已验证视图的查询函数。新的封装要求在确切的当前纪元具有当前写权限，加密前与签名后各检查一次；每次执行都重新加密，因此重试必须重发返回的字节。
- 读取时先认证历史作者再解密：被吊销作者的旧内容仍可打开并归属到原成员（账本快照之后同样如此），但这不授予当前写权限。Streams 绑定还要求内容快照签名者在取 key 前和解密后仍有当前写权限；历史增量仍可读取。

## 投递（分发器内部）

`deliverEpochEnvelope`（内部）执行一轮 put 与回读。outbox 中已保存的字节优先于新生成的字节。后端 `unavailable` 时投递保持 `Pending`，原始字节不变；其他后端失败会向上传播。

### 保留状态起点

retained 起点包含本调用方导出的完整 v2 状态，以及紧接其后的数据源 `offset`。
恢复保留“完整历史 / 背书快照”的来源。损坏、未知版本或其他 genesis 返回
`retained-cache-invalid`，可用独立验证的原始记录重建可选缓存。缓存长度超过 pin
也属于缓存无效；长度相等必须 head 相等。pin 更长时提供 `LedgerFeedSource`，
打开过程先验证后缀并证明 pin 位置的哈希，再保存新增记录。缺失或冲突的证据返回
`local-evidence-conflict`，不能据此重置 pin。

建议每新增至少 64 条记录调用一次 `rebase()`，提供运行时共用的 `VerifiedLedger`。
它先推进 pin，再在一次存储事务中 CAS 替换起点并删除已覆盖的 feed 行；保存返回的
起点供下次打开。界面需要的原始历史另行保留。压缩中断后可从原件重建，或读取后缀
证明已有 pin，不得降低 pin。

`InstalledEpochKeys.check(epoch)` 检查已安装密钥的当前资格和承诺，随后释放临时
密钥材料；状态读取方无需领取秘密。

## 设备访问凭证绑定

`deviceCredentialBindingBytes`、`signDeviceCredentialBinding` 和
`verifyDeviceCredentialBinding` 把新设备的访问凭证哈希绑定到审批端正在处理的配对会话。
签名字节依次为 UTF-8 `lody-e2ee/device-credential-binding/v1`、一个零字节、
已钉住的 genesis（32 字节）、配对会话 ID（16）、新设备 Ed25519 公钥（32）、
原始凭证的 SHA-256（32）。调用方必须传入可信的会话和 genesis；签名有效不代表设备已入账，
也不能代替持钥证明。验证沿用严格 Ed25519 规则。创建者的第一台设备不需要这份证明。
`test/foundation.test.ts` 保存固定签名向量，并检查所有上下文字段被替换时都拒绝。
