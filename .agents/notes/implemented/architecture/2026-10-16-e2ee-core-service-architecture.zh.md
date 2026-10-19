# E2EE core 拆分为端口、流程与适配器

Status: implemented
Translation: current

[English](2026-10-16-e2ee-core-service-architecture.md)

## 摘要

`@lody/e2ee-core` 原先暴露约二十个工厂函数：每个都自己打开 SQLite 文件、以裸回调接入远端系统，并各自维护一份回滚钉。这让库难以在 Lody 之外复用、难以阅读，也无法换用别的后端或存储。现在核心拆为端口（由应用提供的 Effect service）、流程（库在端口之上以 Layer 实现的 service）和适配器（SQLite 与 Loro Streams 实现），通过六个按使用者角色划分的入口加一个不稳定的 `./internal` 暴露。协议字节、存储保证和流程行为保持不变，原有行为测试全部改为针对真实 Layer 运行；主要剩余限制是目前只有 Node SQLite 与 Loro Streams 两类适配器。

## 问题

- 每个流程工厂（`makeSqliteEpochReceiver`、`makeSqliteKeyDistribution`、`makeSqliteEpochRotation` 等）接收路径、模式、保护器和远端回调，自行打开存储并嵌套其他工厂。组合关系隐式且重复；换后端或存储只能复制代码。
- 每个存储都内嵌一份账本钉，回滚保护被复制到七处，错误映射略有差异。
- 二十五个子路径混合了纯协议、仅宿主可用的流程、适配器和测试辅助；README 仍在描述更早的抽取阶段。
- 错误通道多为 `unknown`；大量函数只是包一层 `Effect.gen`。

## 决定

1. **端口**（`./services`）：后端（`LedgerLog`、`LedgerFeedSource`、`KeyMailbox`、`EpochStagingStore`）、平台（`DeviceIdentity`、`KeyProtector`、`CandidateProtector`）、应用（`WorkspaceScope`、`LedgerViewSource`、`EpochPublicationSource`）和本地存储（每个日志或存储一个端口）。端口带有类型化错误（`BackendError`、`LocalStoreError` 等）与 JSDoc 合同。
2. **流程**（`.`）：`VerifiedLedger`、`LedgerFeed`、`LedgerSubmission`、`InstalledEpochKeys`、`InstalledEpochHistory`、`KeyReceiver`、`KeyRepair`、`KeyDistributor`、`EpochPublisher`，均为带 `layer` 的 `Context.Service`，只依赖端口和协议代码；`E2eeWorkflows` 负责组合。
3. **唯一的回滚守卫。** `VerifiedLedger` 加一个 `LedgerPinStore` 取代各存储自带的钉；钉故障测试集中到一个归属测试套件。
4. **适配器**（`./adapters/node-sqlite`、`./adapters/loro-streams`）。每次存储写入都在同一事务内读回校验自身写入以及文件的工作区/设备绑定，被篡改或被忽略的写入会回滚，与旧存储一致。
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

## 验证

核心：20 个测试文件（共 356 个测试，含组合测试与公开文档测试），使用真实 SQLite、Ed25519、HPKE 与子进程。`test/composition.test.ts` 通过 `E2eeWorkflows` 在两台设备之间完成一次密钥分发。`test/public-docs.test.ts` 要求每个公开导出、命名空间导出与 service 成员都有 JSDoc，并要求 `docs/surface*.md` 与实际导出一致。收尾测试还覆盖类型化源失败不推进检查点，以及查询/确认 span 正常结束。本次收尾通过核心类型检查、类型感知 lint（有既存警告）、Effect lint（有建议性警告）和根目录 format；隔离工作区缺少其他包依赖与 ACP 子模块，全仓 `check`、公开边界检查和文档检查未能全部通过，没有报出 E2EE 文档错误。

完整五层栈还通过了核心与 Lab 类型检查、全部 401 个核心测试和 201 个 Lab 测试。工作区将刷新失败转换为 `LedgerViewSourceError`，Lab 迁移后的组件辅助代码保持同一端口合同。工作区/恢复 service 成员也受更严格的文档检查约束。这些本地合成测试结果不代表生产验收。

限制：Lab 与桌面端消费者在栈中后续 PR 里迁移；尚无 IndexedDB 或移动端存储适配器；生产组合仍未接入。包仍为 `private`、版本 `0.0.0`；服务边界可复用不代表独立 SDK 或后端已经发布。
