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

`canWriteRetainedEpoch(epoch)` 只检查可选的持久本地观察日志，不读取 source。产品内容绑定仅在当前 key 真实缺失时使用。十五分钟首次观察截止时间、保守的时钟连续性和提示规则见 [owner 取舍](../../../.agents/notes/implemented/architecture/2026-10-27-e2ee-epoch-receive-barrier.zh.md)；该方法不授予设备或角色权限。缺少日志支持时仍要求当前 key。

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

自助设备记录若在 CAS 前明确收到 `LedgerLogError.reason = self-service-rate-limited`，P09 仅在本次新建槽位的首次尝试且修订号未被其他尝试推进时释放该原件，保留检查点并返回 `retryAt`。SQLite 与 IndexedDB 原子核对原件、检查点、修订号；SQLite 对既有日志只增补修订字段，保留待定原件与检查点。结果未知、旧 pending、并发尝试及普通 HTTP 429 都继续保留原件，不允许借后续拒绝抹掉先前可能生效的请求。

## InstalledEpochKeys 与 InstalledEpochHistory

_需要 `WorkspaceScope`、`DeviceIdentity`、`VerifiedLedger`、`KeyProtector`、`InstalledKeyStore`。_

本地密钥材料的唯一所有者。`saveAndReload(epoch, key)` 按以下顺序执行：

1. 对照账本承诺检查密钥，用 `KeyProtector` 封装。封装的 body 为 `purpose ‖ genesis ‖ device ‖ epoch ‖ commitment ‖ key`。
2. 验证新的密钥块可以打开。
3. 存储；先写入的密钥块胜出。
4. 只有*已存储*的密钥块能重新打开并匹配，才算成功。

无法读取的已存密钥块，只能被已成功打开并匹配的新块替换。`read(epoch)` 返回由调用方释放的全新不透明密钥。两者在每个异步步骤之后都会重新确认本设备仍是有效成员。

`InstalledEpochHistory.read(epoch)` 返回已安装的密钥。只有该密钥确实缺失时，才从最新已安装的密钥出发验证整条签名历史包链，保存恢复出的旧密钥，并返回所请求的那个。损坏、权限和存储失败从不被“恢复”。这只恢复已安装的历史，不是 vault。

恢复从账本当前 Epoch 向下寻找本地已安装的最高 Epoch 密钥，因此当前信封尚未送达时仍可读取旧历史。请求的密钥缺失时，必须有更高 Epoch 的已安装密钥才能回溯。查找只跳过缺失记录，其他错误直接上抛。`recoverLedgerHistory(view, key, startEpoch?)` 使用对应 Epoch 的已验证承诺校验起始密钥，包括 Epoch 0；省略 `startEpoch` 时使用账本当前 Epoch。

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
- 邮箱页中的路由无法解析，或 sender/工作区/epoch/收件人提示与信封原件不一致时，仅跳过本次，不登记任务、不拒绝 digest；正常元数据恢复后仍可重试。同页后续信封继续通过完整验签、权限、HPKE、commitment 检查。`processed` 是扫描行数，不是已安装密钥数量；实际安装失败仍不返回 `next`。
- 只有真实的账本变化才把任务结束为 `Obsolete` 或 `Revoked`。
- 报告排队或发送前都会重新做账本检查；邮箱版本提示每一步只查询一次，紧挨在排队或发送之前。

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

每个接收者在每个纪元的第一份密文永久保留，并在每次重试时重新发送；版本号变化只触发重试，从不产生新密文。恢复设备可以接收密钥，但从不发送。`Observed` 表示邮箱返回了完全相同的字节，不表示接收者已安装。日志满时新任务以 `task-limit` 失败；确认会释放容量，但不删除历史。不同接收者的排程与投递并发进行（最多同时八个），同一接收者的步骤保持顺序。读取已安装密钥是例外，一次只读一个：托管写者契约允许忙时直接以 conflict 失败而不排队（浏览器适配器只在同一标签页内排队），并发读取可能让每轮只有一个接收者能送出。结果仍按接收者/任务顺序逐个检查：一个接收者受阻不会阻塞其他接收者，存储损坏则整批失败。

## EpochPublisher

_需要 `WorkspaceScope`、`DeviceIdentity`、`VerifiedLedger`、`InstalledEpochKeys`、`CandidateProtector`、`EpochStagingStore`、`LedgerSubmission`、`EpochCandidateStore`。_

换代纪元密钥（`publish`），或在一条签名记录中移除成员并换代（`publishRemoving`，仅 owner）。

本地候选信封列表使用独立的规范 CBOR 限制：最多 4096 个信封，编码后不超过 2 MiB。
账本记录和背书快照仍保留数组最多 32 项的限制。

`publishAbandoning(baseEpoch)` 仅允许已声明 capability 2 的 Owner 个人设备：读取本地持有的未废弃 baseEpoch 密钥，沿同一候选／暂存流程签署 tag11，历史钥链跳过废弃区间；调用方负责明确确认。所有重试保留原始字节。见[控制面可用性](../../../specs/e2ee/control-plane-availability.zh.md)。

```text
生成密钥 → 封装历史包 → 签名记录 → 为每台设备生成信封
→ 保存候选（由 CandidateProtector 保护）并回读
→ 暂存完整信封组，并精确回读
→ LedgerSubmission.submit
→ Committed：经 InstalledEpochKeys 安装 | Conflict：丢弃候选密钥
```

`resume` 在崩溃后完成同一个候选，不再签名。匹配的 publication 原件进入 `LedgerSubmission` 后，恢复跳过重复暂存／读回，直接对账同一 CAS，不再依赖暂存服务可用。只有 candidate、尚无 submission 时，首次提交仍须完整暂存并精确读回。`cleanupStaged` 在该纪元被不同承诺占用后删除本设备的暂存组。`acknowledge` 释放已完成的结果。只有 owner 或 admin 的个人设备可以换代。绕过暂存直接追加的管理者可以扣留密钥：这是已知的可用性限制，不破坏机密性。

MVP 独立移除在 capability 1 的 `DeclareCapabilities` 命令入账后，使用 `WorkspaceControl.execute({ _tag: "RemoveMember", membershipId })`。它撤销全部设备，保留 epoch 并提示手动换代；`EpochPublisher.publishRemoving` 仍保留独立的 tag8 原子契约。

Candidate 丢失时，只有真实提交或冲突证明后才能对账同一 submission 原件，
parent 未变化时不能因此发 CAS。正常 receiver 可独立安装已提交密钥；已安装密钥
允许终态确认，无须重新打开 candidate blob。未发布密钥不得绕过 CandidateProtector，
未知结果不得重新签署。

## WorkspaceControl 与密钥轮次

`WorkspaceControl`（_需要 `DeviceIdentity`、`LedgerSubmission`、`LedgerSync`_）在刚刷新的视图上签名普通命令（接纳成员或设备、设置角色、吊销、转移 owner），每条只提交一次。存在待处理或未确认的提交时禁止新的签名；只有本地 feed 已包含提交时观察到的检查点，结果才会被确认。

`runWorkspaceKeyRound(limit, cursors)`（_需要 `KeyRepair`、`KeyReceiver`、`KeyDistributor`_）是一轮有限的维护：发送修复、恢复安装、获取一页邮箱、发送报告、协调并投递、再次发送报告、列出结果。每个队列各自保留游标提示。

收钥（包括已提交的暂存组）与发钥是分别尝试的有限阶段。收钥失败不能阻止协调和投递。
`WorkspaceKeyRoundFailure` 分别保留 `receive`、`distribution` 的 Result、发钥后报告的 Result
和重试 `cursors`；成功阶段可前进，失败阶段保留输入游标。整轮成功时沿用原结果字段。

邮箱获取会跳过非当前 sender，不安装或保存其密钥。只有精确路由上的严格签名和真实账本中
已退出当前成员状态的历史身份，才能产生 `retiredDigests`，由轮次提交按摘要绑定的修复。
未知 sender 只设置 `refreshRequired`，不拒绝摘要。宿主必须刷新已验证账本后重试；工作区
门面已有账本源刷新，桌面维护则在独立发钥之后，通过现有已验证历史摄入路径每次最多刷新一次。

## E2eeWorkspace

以上一切之上的应用门面。`WorkspacePlatform` 为每个工作区提供端口 Layer（`WorkspacePorts`）、每个资源的原生文档状态，以及可选的恢复配置。`E2eeWorkspace.open()` 在工作区 Scope 中构建 `E2eeWorkflows` 与 `WorkspaceControl`，返回一个句柄：账本命令、换代与移除、密钥轮次、文档（`document(resource, model)` 返回 Streams 绑定和原生状态）、结果与确认、恢复。

句柄上会改变状态的调用是串行的。`close()` 停止平台工作、等待进行中的操作，然后释放流程与存储。`E2eeWorkspace.restoreFromRecovery` 先执行恢复设备的恢复流程，再打开新个人设备的工作区并安装恢复出的密钥。

## 恢复

`RecoveryVaults`（_需要 `RecoveryVaultStore`、`RecoveryVaultLocalStore`_）创建并解锁 vault-v1：离线保存的恢复文件，或 passkey PRF。passkey 需要一次报告 `enabled: true` 的注册，以及一次带用户验证并返回 32 字节 `results.first` 的认证；WebAuthn 在认证时从不报告 `enabled`。所有 ceremony 都使用 `vaultPrfInput()`，`user.id` 为 `passkeyUserHandle(vaultId)`，所以没有恢复文件的新设备可以从 ceremony 得知保险库。加密索引列出每个 passkey，CAS 引用它的包装，服务端不能把它当作未引用条目删除。`makeWorkspaceRecovery` 维护某个工作区的恢复条目（设置、测试、替换、跳过）并执行恢复。整库换新时，`revokeOtherRecoveryDevices` 依据已验证的账本撤销这个成员的其他恢复设备。恢复时：账本必须包含恢复包的 `head` 和 `length` 检查点，否则停止；恢复先尝试当前代次，再尝试最高可用已提交代次，并验证、安装其完整历史链。当前信封缺失或无效时，只要旧代次可用，仍可接纳新个人设备；epoch 0 时，经过验证的恢复身份本身即可接纳。`partialEpochKey` 表示只恢复了治理入口，较新代次仍需修复或废弃；`epoch` 为最高恢复代次，没有密钥时为 null。账号恢复的进度保持为可重试的 `partial`，直到补齐当前代次密钥。epoch 0 的信封投递在途时保持 `Pending`，不接纳零密钥设备。账本、本机加密能力与存储故障仍会失败。每个私有包是带 `formatVersion: 1` 的规范 CBOR；缺失或其他版本、或私钥不是 48 字节 RFC 8410 PKCS#8 Ed25519/X25519 精确编码时，上传前与读取时均以 `invalid-input` 失败。`deriveRecoveryAccessCredential` 派生 R 的服务访问凭据（对 R 的种子做 HKDF-SHA256，salt 为 genesis，info 为 `lody-e2ee/recovery-credential/v1\0` 加 R 的公钥）。设置流程提交 R 的接纳记录时把其 SHA-256 传给 `submitOriginal`，其他记录一律传 `null`；`E2eeWorkspace` 的账本端口不携带凭据，因此在提交前交给平台的 `registerRecoveryCredential`。方案见白皮书的备份与恢复一节及[恢复 vault](../../../specs/e2ee/recovery-vault.zh.md)。

设置、个人设备恢复和替换时的撤销操作在 Pending 或尚未证实的 Conflict 后保留签名原件。只有已验证历史证明原位置被其他记录占据，才可使用同一组设备密钥重签。压缩裁剪了该位置的哈希时，位置之后的真实视图可用完整设备历史证明目标从未被准入，或用目标仍有效的状态证明撤销从未发生；本地日志通过 CAS 替换后，由下一次调用提交。旧设置日志仅在未完成登记时回推位置；R 已有效时，即使准入哈希被裁剪，也可在原件提交对账后完成。完成登记后清理原件与位置，单独保留 R 公钥供显式放弃流程使用。

## 文档

文档内容使用 content v0：签名头部，以由纪元密钥派生的文档密钥做 XChaCha20-Poly1305 加密，AAD 绑定用途。

- **Loro / streams-crdt**：`streamsDocumentBinding({ resource, model, writeEpoch })`（`@lody/e2ee-core/adapters/loro-streams`）是 `@loro-dev/streams-crdt` 文档的载荷保护绑定。它封装更新（头部 3）与快照（头部 4，续读 offset 位于签名头部内），并打开读到的内容。签名器、账本视图与密钥分别取自 `DeviceIdentity`、`VerifiedLedger` 与 `InstalledEpochHistory`。
- **其他传输**：`sealDocument`、`openDocument` 与 `authenticateDocument`（`/protocol`）接收文档密钥、签名器和已验证视图的查询函数。新的封装要求当前写权限及不晚于当前的已验证发布纪元，加密前与签名后各检查一次；待手动换代时仍可使用保留密钥发送；每次执行都重新加密，因此重试必须重发返回的字节。
- 读取时先认证历史作者再解密：被吊销作者的旧内容仍可打开并归属到原成员（账本快照之后同样如此），但这不授予当前写权限。Streams 快照和增量都要求历史账本准入、有效签名、可解 epoch 与 AEAD；读取不要求作者当前仍有效。

## 投递（分发器内部）

`deliverEpochEnvelope`（内部）执行一轮 put 与回读。outbox 中已保存的字节优先于新生成的字节。后端 `unavailable` 时投递保持 `Pending`，原始字节不变；其他后端失败会向上传播。

### 保留状态起点

retained 起点包含本调用方导出的本地 v5 状态与数据源 `offset`，保留来源、
该视图已有的全部已验证哈希，以及用定长头部标明长度的二进制表保存的代次发布原件，不受 CBOR 数组项数上限限制。
保留状态编解码器和 feed 适配器共用 64 MiB 上限，每个 feed 仍遵守其配置的字节预算。
因此压缩不会删除未决提交、
候选代次或安装日志依赖的锚点。这些证据仍受 feed 字节预算限制；容量不足时
保留原缓存和日志。远端快照、比较摘要与本地保留状态均使用 v5。快照导入不会
虚构旧哈希或发布原件：当前密钥可通过已认证的普通邮箱安装，后续发布记录
则恢复正常的 staging 发现路径。

建议每新增至少 64 条记录，提供运行时共用的 `VerifiedLedger` 调用 `rebase()`。
它先推进单调防回滚 pin，再在一次事务中替换起点、删除覆盖行并保存位置。
重开时识别事务已保存的本地起点，即使进程未及另存返回值便崩溃也能恢复。
较新的缓存必须包含独立 pin；位置相同必须 head 相同。

打开时提供 `LedgerPinStore` 与 `LedgerFeedSource`，以启用有界恢复。缓存损坏
或格式过旧时，SQLite 与 IndexedDB 的 `rebuild` 先从 genesis 重放原件，证明
最高缓存末尾及独立 pin，再在一次事务中 CAS 替换 feed 缓存。写入中断保留旧缓存；
pin 和工作流日志从不清空。缺失历史、网络或存储失败、证据冲突都会保留可重试的
失败，不能据此降低检查点。无效 genesis/快照起点、协议升级要求和原生验证不可用直接返回，不触发网络修复。
以 genesis 为起点的有效缓存落后于独立 pin 时，也会通过数据源追赶。
未实现 `rebuild` 的自定义存储对不可用缓存返回
`retained-cache-invalid`。

`InstalledEpochKeys.check(epoch)` 检查已安装密钥的当前资格和承诺，随后释放临时
密钥材料；状态读取方无需领取秘密。

## 执行意图

`executionIntentBytes`、`signExecutionIntent` 和 `verifyExecutionIntent` 对加密输入将要执行的
内容签名（owner 2026-11-10 决定）。签名字节依次为 UTF-8 `lody-e2ee/execution-intent/v1`、一个零字节、
类型（1 成员输入，2 机器输入，3 定时任务声明）、已钉住的 genesis（32 字节）、四个 u16be 长度前缀的
UTF-8 字段（工作区 ID、目标机器 ID、作用域、消息 ID，各不超过 1,024 字节），以及规范化内容的
32 字节 SHA-256。不依赖任何文档操作、帧或 epoch。签名有效只证明作者身份；验证方仍要检查签名者
当前的成员身份和权限，执行日志仍保证每个消息 ID 只启动一次。

## 设备访问凭证绑定

`deviceCredentialBindingBytes`、`signDeviceCredentialBinding` 和
`verifyDeviceCredentialBinding` 把新设备的访问凭证哈希绑定到审批端正在处理的配对会话。
签名字节依次为 UTF-8 `lody-e2ee/device-credential-binding/v1`、一个零字节、
已钉住的 genesis（32 字节）、配对会话 ID（16）、新设备 Ed25519 公钥（32）、
原始凭证的 SHA-256（32）。调用方必须传入可信的会话和 genesis；签名有效不代表设备已入账，
也不能代替持钥证明。验证沿用严格 Ed25519 规则。创建者的第一台设备不需要这份证明。
`test/foundation.test.ts` 保存固定签名向量，并检查所有上下文字段被替换时都拒绝。

桌面维护的错误分类、独立分页与终态消费见[收发钥可用性](../../../.agents/notes/implemented/bug-fix/2026-10-27-e2ee-key-maintenance-availability.zh.md)。`MailboxInstallError.cryptographicRejection` 仅标记信封验证阶段确定的拒绝；本地写入、报告签名和未知原生错误不能授权拒绝信封。

恢复也可以修复已获准、但本地工作区密钥丢失的个人设备。验证恢复设备、
包内检查点与可用已提交代次信封（epoch 0 也可仅验证恢复身份）后，必须匹配当前个人设备的签名、公钥和成员身份，
再通过原有密钥安装边界恢复，不重复接纳设备。已撤销或身份不匹配的设备不会
因此获得权限。

`WorkspaceControl.execute` 发起所有者转让时，要求目标至少有一台活跃个人设备。撤销成员最后一台个人设备需要 `confirmedRecoveryOnly: true`；该确认仅用于工作流，不进入 v1 签名字节。已有 v1 记录仍按原规则回放，保留所有者治理设备检查。
