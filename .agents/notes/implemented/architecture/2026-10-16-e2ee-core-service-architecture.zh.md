# E2EE core 拆分为端口、流程与适配器

Status: implemented
Translation: current
PR: [Browser ledger/original stores #2053](https://github.com/LodyAI/Lody/pull/2053) · [Browser custody/key journals #2060](https://github.com/LodyAI/Lody/pull/2060)

[English](2026-10-16-e2ee-core-service-architecture.md)

## 摘要

`@lody/e2ee-core` 原先暴露约二十个工厂函数：每个都自己打开 SQLite 文件、以裸回调接入远端系统，并各自维护一份回滚钉。这让库难以在 Lody 之外复用、难以阅读，也无法换用别的后端或存储。现在核心拆为端口（由应用提供的 Effect service）、流程（库在端口之上以 Layer 实现的 service）和适配器，通过按角色划分的入口加不稳定的 `./internal` 暴露。Node SQLite、浏览器账本/原件 IndexedDB、JS 曲线和 Loro Streams 适配器分别提供能力；存储不授予权限。协议字节和流程保证仍归既有 core，产品组合独立于这些存储、密码与可选持久保管适配器。

## 问题

- 每个流程工厂（`makeSqliteEpochReceiver`、`makeSqliteKeyDistribution`、`makeSqliteEpochRotation` 等）接收路径、模式、保护器和远端回调，自行打开存储并嵌套其他工厂。组合关系隐式且重复；换后端或存储只能复制代码。
- 每个存储都内嵌一份账本钉，回滚保护被复制到七处，错误映射略有差异。
- 二十五个子路径混合了纯协议、仅宿主可用的流程、适配器和测试辅助；README 仍在描述更早的抽取阶段。
- 错误通道多为 `unknown`；大量函数只是包一层 `Effect.gen`。

## 决定

1. **端口**（`./services`）：后端（`LedgerLog`、`LedgerFeedSource`、`KeyMailbox`、`EpochStagingStore`）、平台（`DeviceIdentity`、`KeyProtector`、`CandidateProtector`）、应用（`WorkspaceScope`、`LedgerViewSource`、`EpochPublicationSource`）和本地存储（每个日志或存储一个端口）。端口带有类型化错误（`BackendError`、`LocalStoreError` 等）与 JSDoc 合同。
2. **流程**（`.`）：`VerifiedLedger`、`LedgerFeed`、`LedgerSubmission`、`InstalledEpochKeys`、`InstalledEpochHistory`、`KeyReceiver`、`KeyRepair`、`KeyDistributor`、`EpochPublisher`，均为带 `layer` 的 `Context.Service`，只依赖端口和协议代码；`E2eeWorkflows` 负责组合。
3. **唯一的回滚守卫。** `VerifiedLedger` 加一个 `LedgerPinStore` 取代各存储自带的钉；钉故障测试集中到一个归属测试套件。
4. **适配器**通过独立入口实现端口，每次存储写入都在同一事务内读回校验自身写入与捕获的绑定，被忽略或不一致的写入会中止事务。SQLite 仍是全部本地端口的参考实现；IndexedDB 还提供安装、密钥及快照 journal；浏览器保管由独立的可选适配器提供。
5. **后端合同**（`./host`）：以 Effect Schema 定义的暂存 DTO、请求签名字节和暂存请求校验，以及邮箱规则函数。平台无关；`@lody/cloud-api` 改为重新导出暂存合同，不再自行定义。
6. **Effect 实践。** 公开方法使用 `Effect.fn` 产生 span；内部辅助使用 `Effect.fnUntraced`；只包 `Effect.gen` 的函数改为 `Effect.fnUntraced`；各流程声明完整的失败联合类型。

## 发现与取舍

- **关闭语义按流程区分。** 让所有流程在 Scope 关闭时等待进行中的调用，会让现有测试死锁：接收、修复和分发本就让进行中的远端工作在下一个守卫处失败，而不是被等待。只有持有原生保护的流程（已安装密钥、历史恢复、发布者）才等待。两种行为都显式表达（`makeAdmissionGate`、`makeCloseGuard`）。
- **构造时捕获。** 旧工厂在初始化时绑定借用的回调，有测试在之后修改它们。流程现在用 `own()` 捕获端口，之后的修改无法替换能力。
- **候选密钥保护保持独立。** 已审定的决定是：尚未发布的换代密钥使用与已安装密钥不同的保护器。该决定保留为独立的 `CandidateProtector` 端口，而不是复用 `KeyProtector`。
- **公开合同收尾。** 文档检查现在遍历命名空间导出与解析后的 service 成员，包括继承的合同。旧检查会漏掉 `Bytes` 导出和没有 JSDoc 的 service 方法。基于编译器的合成用例验证拒绝和通过两种结果；文档质量仍需人工检查。公开账本/密钥流程的查询与确认操作也补上了命名 span，不添加参数属性、不安装遥测。`LedgerViewSourceError` 替代视图端口的 `unknown` 错误通道；预期的源失败保留 cause，且不改变回滚检查点。这改变了适配器的编译期合同，不改变账本或线上格式。
  提交确认仍在方法调用时复制参数，早于惰性追踪函数开始执行；真实 journal 测试在执行前修改调用方参数，确保这个所有权保证不变。
- **投递拒绝会向上传播。** 只有邮箱 `unavailable` 时投递保持 `Pending`；拒绝（unauthorized、conflict）视为失败，延续旧实现中“传输丢失”与“宿主拒绝”的区分。
- **统一的 feed 存储。** 全历史与快照 feed 共用一个 `LedgerFeedStore`（起点加后续原始记录），验证逻辑在 `LedgerFeed` 中。由于尚未部署，各存储文件格式都重新定版本。
- **考虑过的替代方案。** 保留工厂函数只补文档：被否决，因为后端和存储仍不可替换。每个模块一个入口：被否决，因为看不出每个导出面向谁。

## 工作区与恢复（栈第 3 层）

- `E2eeWorkspace` 门面不再接收预先构建好的工厂对象：`WorkspacePlatform` 返回一个端口 Layer，门面在工作区 Scope 中构建 `E2eeWorkflows` 与 `WorkspaceControl`。句柄的方法保持不变，平台只需改变提供资源的方式。
- `LedgerSync`（应用端口）取代原先的账本客户端加检查点回调。工作区由 `LedgerSync.refresh` 派生 `LedgerViewSource`，保留“每次流程读取都刷新 feed”的旧行为。
- 恢复 vault 存储改为两个端口（`RecoveryVaultStore`、`RecoveryVaultLocalStore`）加一个 `RecoveryVaults` 流程；vault 线上 DTO 以 Schema 形式移入 `./host`，`@lody/cloud-api` 重新导出（与暂存一致）。
- 工作区错误改用带 `reason` 的 `Schema.TaggedError`，与其他公开错误一致。

## Lab 基于服务运行（栈第 5 层）

- Lab 的 `WorkspacePlatform` 像外部集成方一样提供端口：其账本 actor 暴露 `LedgerSync`、`SubmissionJournal` 与 `LedgerLog`，HTTP 邮箱与暂存客户端分别成为 `KeyMailbox` 与 `EpochStagingStore`。账本钉与候选文件按 actor 区分，因为多个 actor 共用一个目录，共享钉会让它们的回滚知识相互耦合。
- 单组件故障测试使用 `./internal` 的测试辅助：它们以真实 Layer 打开单个流程（接收方、分发方、发布者等），并带各存储的选项，不存在第二份实现。
- 平台回调 `documentState` 与 `recoveryConfiguration` 会收到工作区已构建的服务，因为平台在组装原生状态或恢复输入时可能需要流程（读取密钥、投递）。
- Lab 对服务错误按 `reason`、对协议错误按 `code` 投影；暂存适配器保留后端拒绝的原因。

## 浏览器存储边界

拒绝按设备创建数据库：替换丢失的身份也会丢失该工作区的回滚知识和未决原件。
IndexedDB 保留一个稳定的账号/工作区/genesis 数据库；配对行额外绑定本地设备、
安装、session 和用途，替换仍保留旧交换。pin revision token 只是本地 CAS 前置条件，
不是权限或模式缓存。

适配器使用短原生回调事务，不在 IDB 中等待 crypto/network。strict durability
是浏览器提示；读回与绑定核对后，以 complete 作为可观察成功边界。
关闭拒绝新工作并等待真实事务 Promise；未知结果从保留的首份字节核对。
不通过备用数据库或隐式 reset 恢复可用性。宿主须独立限定 retained 账本状态、
验证审批，在入库前保护配对中的秘密，并按[custody 合同](../../../../specs/e2ee/client-custody.zh.md)
处理持久保护丢失。独立稳定客户端布局现已保留安装、receive/report、installed/candidate、distribution/outbox/repair 与快照发布 journal。store 不执行远端邮箱操作或审批验证。

## 验证

`packages/e2ee-core/test/composition.test.ts` 用真实流程 Layer 与密码实现验证设备收钥，
`packages/e2ee-core/test/public-docs.test.ts` 检查 JSDoc 与入口清单。
`packages/e2ee-core/test/indexeddb.browser.test.ts` 使用真实 Chromium/WebKit 持久
profile，覆盖进程重开、双 tab 竞争、原生 abort/配额/写入不一致和关闭，
验证精确原件保留、记录/游标原子回滚及限定 retained 状态的重开。
这些合成浏览器引擎检查不代表最低 OS、真机或生产验收。包仍为 private、
版本 0.0.0；可复用边界不代表已发布独立 SDK 或已启用产品 host。

## 浏览器保管理由

没有采用标签页全生命周期锁：空闲保护工作不应阻塞其他窗口。宿主在分配身份前进入
作用域内有限 Web Lock，持有到真实本地/原生调用结束，网络等待前释放。按数据库或
设备分锁会容许竞争安装；取消时抢锁会让尚未结束的原生工作与新写者重叠。
因此重入核对真实持锁 fiber，而不只看继承的 Context；子 fiber 自己拿锁。有限本地
序列无需并行写者，给所有后代增加借用计数会引入额外的所有权机制。

单独保存不可导出 key 不足以证明持久可用：创建意图、key/probe 读回、实际解密与事务
内写入/读回/恢复共同建立证明。只要该安装分区仍有原件、nonce 或 journal，marker/key
同时缺失也不代表首次安装；创建事务核对全部绑定分区。会失败的可用性探针先于包装
意图，因而加密前的临时配额故障可重试。意图提交后，原生加密和密文保留不可中断；
进程崩溃或真实未知结果仍不能作为新加密重试。加密前保留 nonce 和计数，未知结果不能触发第二次
加密。完成原件按精确字节恢复，歧义半成品保持阻塞。作用域安装指针与退休归档原子
切换，桌面批准替换后仍保留旧 journal。首次包装候选归待决请求的本地完成回执，
本地完成不等于桌面审批。浏览器引擎测试覆盖这些边界与全部固定用途，但不证明最低
OS 硬件或断电验收。已批准 Spec 与账本 v1 均不变。

## 个人设备产品组合

可选 [`@lody/e2ee-client`](../../../../packages/e2ee-client/README.zh.md) 在 core 之外
拥有个人配对、打开、收钥、管理与 RPC 组合。桌面消费同一配对编解码、固定完整历史
验证器和有限收钥维护流程；原生存储只是适配器，不复制第二棵协议实现。可移植 RPC
也只保留一个 Effect 不可变存储端口和薄 SQLite 兼容包装。此处不启用产品传输。

冷重开后，回执不能认证独立传入的 endorser。因此既有 device-credential 用途保护
当前版本本地 CBOR `[1, credential32, pinDigest32]`。SHA-256 摘要覆盖 JSON 数组：
域 `lody-e2ee/client-credential-pin/v1\0`（一个 NUL）、账号、工作区、genesis/device
hex、installation ID、原 genesis record hex、endorser、membership。排除 session，
使明确终态后的重试保留同一 credential/身份；pending/admitting/未知尝试不能换 session。
这是本地受保护载荷，不是新包装、签名或账本格式。

完整历史证明可能超过固定单消息配对上限。独立、有界、不可变的公开分页证据端口
原子提交全部分页、数量/大小/摘要；校验和或已存审批标签都不是权限。替换携带首次
快照原件，不递归嵌入旧审批。新签名完整历史重新限定其历史管理员、签名和精确状态，
然后才重开既有 origin/pin。自签缓存或按新设备另开 feed 命名空间会掩盖信任丢失和
回滚证据，因此均不支持。

账本所有者先于延迟创建的密钥所有者。独立密钥/repair 失败可重试，当前钥缺失时
仍可用获准的保留 epoch。替换先验证新审批与 pin，再排空健康旧 owner，按已批准
合同原子切换归档/current。Scope 关闭先停止接纳、等待操作，再释放密钥/credential/
存储，不删除身份或未知原件。秘密与 RPC 明文通过 `acquireRelease`/`acquireUseRelease`
接管到登记清零责任；只等待原生完成，取消仍可能在返回到调用方时遗失缓冲。
操作 Scope 在成功、失败、中断时负责清理，关闭先等该 Scope 结束，再释放 custody。
仅有限的本地获取不可取消，不把远端策略或网络等待移入 custody 所有权。
浏览器引擎与桌面回归验证这些合同；最低 OS 真机、
原生插件和断电耐久仍需独立验收。


scoped host 构造器保留为实际 drain 原语。产品组合使用
`makeOwnedPersonalDeviceHost(ports)`，在独立于消费方的保留 Scope 中获取整个拥有资源的
端口 Layer。host、session 和父 Scope 关闭共用每次 drain 的五秒等待预算；超时返回
`PersonalCloseIncomplete` 及窄恢复 owner。保留完整失败与 owner，连同物理锁、借用缓冲
和未决原件，直到实际结算或确认原生终止。超时不证明关闭成功，也不允许同绑定 runtime
交接。

只串行化有限的 ticket 创建；原生 drain 在临界区外运行。并发调用观察同一 ticket，
某个 session 等待时，独立 reader 仍可读取账本。替换先排空匹配的 owned reader，再调用已提供的外部 owner drain，之后才原子切换
身份。父级退休等待每个子 ticket 后才释放整个端口 Layer，不能依赖第二次 `Scope.close` 等待已关闭中的子项。晚到结算成功后可以显式
确认关闭，已关闭句柄不会复活。明文交接还记录等待消费者是否退出，确保发布前、发布到
接收之间取消时，worker 返回值的清零责任都不丢失。

共享 makePersonalWorkspaceRuntime 消费该 owned 构造器和既有 E2eeWorkspaceRuntime/内容桥，
不增加第二套传输或模式缓存。应用独立固定账号/工作区/genesis，提供本地原件及执行入口。
只读打开拒绝缺失的 ready 身份；创建只由明确配对准备触发。没有当前 key 时仍允许已获准
的保留 epoch，包括 no-key lease 之后才到达的保留 key。每项操作仍由 core 核对精确设备
和当前选定的已验证账本。

兼容的可选预分配 reader 合同使 provider 在冷打开前保留自己的标签，解包未返回时也能
调用有界 native close；晚到 open 不能记录身份或发布正文。关闭一个排队标签不退休另一个
持有 custody 的 opener。旧桌面 host 不宣称该可选能力。标签仅为临时所有权，不是持久
pin 或权限。未完成关闭保留 owner 以供重试，空的失败初始化不累积恢复 owner 链。

reader 生命周期不同于整个 host：关闭一个 reader 不影响其他 reader；最后一个 reader
停止接纳该 session，未完成 ticket 保留待确认。账号改变、首次获取时关闭会退休整个绑定
组合；重新观察到原账号不能复活它。provider 并行启动 native fencing 和独立 renderer
清理，保留完整失败及精确账号/reader 租约；后继获取先重试确认旧关闭。先等待整个原生
操作才调用 close 会掩盖期限；吞掉 close 错误会允许重叠；永久缓存 timeout 会阻塞安全复用，
因此均未采用。

设备 grant 留在已批准的 session 中，产品只取得专用短期正文/附件 token。RPC/策略工厂
只有真实装配才暴露能力，不用空成功 handler。机器共享 Layer 是可信 host 组合，须保留既有
密码、原件、generation 与 freshness 策略；bridge 提供固定服务和所有权，不另写策略验证器。
普通管理使用 core 原件提交/ACK、原子成员移除和换代恢复。远端历史分页仅确认同一已验证
feed，本地展示行按真实 view 中的绝对位置摘要核对。

共享内容桥即使面对仍有其他 reader 的底层 runtime，也拒绝晚到 grant/RPC/token 结果。
epoch tracker 在拒绝已关闭 reader 的晚到结果前清零明文；取消检查不要求原生组合 signal API，
测试模拟缺失该 API 后走既有 token 入口。这些是本地所有权/兼容性规则，不改变签名字节或权限。

这里只提供公开可选组合，不启用 Web/移动端产品。浏览器测试使用真实 custody、IDB、邮箱
密码、签名 RPC 和暂停原生工作；策略 Layer 用例证明组合/scope，不代表新策略存储实现。
renderer 回归覆盖精确租约、未完成关闭重试、普通准入及保留 key 唤醒；均不证明移动端
真机、原生插件、断电或原生进程终止已验收。[#2075](https://github.com/LodyAI/Lody/issues/2075)
跟踪 owned close 与 bridge 采用；启用移动端 custody 前，产品组合仍必须保留未结算的原生 owner。
