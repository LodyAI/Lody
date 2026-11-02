# 架构

[English](architecture.md) · [导读](../README.zh.md)

## 分层

```text
            应用（Lody 桌面端、Lab、你的应用）
                │ 调用流程，提供端口
┌───────────────▼───────────────────────────────────────────────┐
│ @lody/e2ee-core            流程（Context.Service + Layer）     │
│   VerifiedLedger  LedgerFeed  LedgerSubmission                 │
│   InstalledEpochKeys  InstalledEpochHistory                    │
│   KeyReceiver  KeyRepair  KeyDistributor  EpochPublisher       │
├───────────────┬───────────────────────────────────────────────┤
│ /protocol     │ /services                                      │
│ 纯协议        │ 端口：后端、平台、应用、本地存储                │
│ （无 I/O）    │ （Context.Service 标签 + 类型化错误）           │
└───────────────┴───────────────▲───────────────────────────────┘
                                │ 由以下实现
     /adapters/node-sqlite   /adapters/loro-streams   你自己的适配器
     /host（后端合同：规则 + 线上格式，供服务器使用）
```

依赖规则（由 import 关系保证）：

- `internal/foundation`、`internal/crypto`、`internal/ledger`（两个有状态流程除外）以及 `internal/keys/{envelope,history,staging,reports}` 是**协议**：同步的 `Result` 函数，只有签名、HPKE 或协作式验证需要异步时才使用 Effect。它们从不导入 service 或适配器。
- **流程**（`internal/**` 中定义了带 `layer` 的 `Context.Service` 的文件）只依赖协议代码和 `services/` 标签，从不依赖适配器、Node API 或 SQLite。
- **适配器**实现端口，可以使用 Node API 和协议辅助函数，但从不决定权限。
- **`/host`** 与平台无关，可在非 Node 的后端运行时中导入。

## 代码地图

```text
src/
  index.ts            "."            流程、错误、结果
  workflows.ts                       E2eeWorkflows 组合
  services/           "./services"   端口与端口错误
  protocol/           "./protocol"   协议汇总
  host/               "./host"       后端合同
  adapters/
    node-sqlite/      "./adapters/node-sqlite"
    loro-streams/     "./adapters/loro-streams"
  internal/           "./internal"   供测试与 Lab 使用的不稳定导出
    foundation/       字节、CBOR、标识符、签名、内容格式
    crypto/           内容 AEAD、纪元 HPKE
    ledger/           记录、重放、策略、快照、准入、feed 分页
                      + VerifiedLedger、LedgerFeed
    keys/             信封、历史、暂存、报告、投递
                      + InstalledEpochKeys、KeyReceiver、KeyRepair、
                        KeyDistributor、EpochPublisher
    submission/       LedgerSubmission
    content/          文档密钥、已封装文档、Streams 内容编解码
    recovery/         恢复身份、vault-v1、工作区恢复 + RecoveryVaults
    workspace/        E2eeWorkspace 门面、WorkspaceControl、密钥轮次、邀请
    lifecycle.ts      准入门、关闭守卫、own()
```

## 生命周期

流程是**有限的**，并且**有作用域**：

- 没有任何后台运行。何时调用 `resume`、`flushReports`、`reconcileCurrentEpoch` 等由应用决定（启动时、账本变化时、重新联网时）。每次调用只处理有界的一页，并返回 `next` 游标提示。
- 每个流程 Layer 存活于应用的 `Scope` 中。Scope 关闭时流程拒绝新调用。关闭行为有两种，按流程选择：
  - **准入门**（`InstalledEpochKeys`、`InstalledEpochHistory`、`EpochPublisher`）：关闭时等待已准入的调用，因为它们借用了原生保护，必须在擦除缓冲区和释放资源之前结束。
  - **关闭守卫**（`KeyReceiver`、`KeyRepair`、`KeyDistributor`）：关闭时不等待；进行中的工作在下一个守卫处失败，因此关闭永远不会等待远端调用。
- 每个流程在构造时一次性捕获其端口（`own()`），之后修改所提供的对象也无法替换进行中工作所用的能力。
- 原生调用不可中断：中断调用方会等到该调用结束、其明文被擦除。
- 库从不调用 `Effect.run*`，程序由应用在入口处执行。

## 信任与持久性

- **唯一的回滚守卫。** `VerifiedLedger.current()` 是流程获取账本状态的唯一途径。它拒绝以下视图：并非真实视图、属于其他工作区、不延续本进程已见内容、不包含持久化 `LedgerPinStore` 检查点。即使持久化钉失败，真实的较新视图也会记在内存中。
- **先存原始字节，再联网。** 每个持久化流程在第一次网络操作前保存确切的原始字节（签名记录、信封、报告、修复 ID），并重试这些字节；重试时从不重新签名或重新加密。
- **结果保留到确认为止。** 已结束的任务会一直出现在 `results` 中，直到 `acknowledge`；不会被隐式消费。
- **提示不是权限。** 邮箱状态、版本号、游标和服务器列表只用于调度；只有真实的账本变化才会把任务结束为 `Obsolete` 或 `Revoked`。
- **本地篡改**（修改 SQLite 文件、操作系统被攻破）不在威胁模型内。存储校验自身写入与绑定，是为了发现缺陷和部分失败，而不是对抗恶意操作系统。

## Effect 约定

- **Service**：`Context.Service` 类。流程提供 `static layer`；端口是普通标签加 JSDoc 合同。
- **错误**：流程错误通常为带 `reason` 字面量的 `Schema.TaggedError`（`ReceiveError`、`LocalStoreError` 等）。较早模块的协议错误（`LedgerError`、`ContentError`、`ValidationError`、`LedgerFeedError`、`EpochStagingError`、`EpochKeyError`）保持 `Data.TaggedError` 与 `code`，因为这些 code 属于已测试的协议行为。每个流程声明完整的失败联合类型（`ReceiveFailure`、`DistributionFailure`、`EpochPublishFailure`、`SubmissionFailure`），核心账本/密钥流程方法没有 `unknown` 错误。应用视图源使用 `LedgerViewSourceError`，协议错误保留具体的联合类型。
- **函数**：公开账本/密钥流程方法（包括查询和确认）使用 `Effect.fn('@lody/e2ee-core/<Service>.<method>')`，应用安装 tracer 后会显示为 span。端口适配器自行选择追踪边界；库不安装 exporter，也不向 span 添加密钥、明文或参数属性。内部辅助与协议函数使用 `Effect.fnUntraced`。纯检查返回 `Result`，再用 `Effect.fromResult` 提升。只包一层 `Effect.gen` 的函数改写为 `Effect.fnUntraced`。
- **资源**：每个纪元密钥副本（`disposeEpochKey`）和明文缓冲区（`fill(0)`）都使用 `Effect.acquireUseRelease`。

## 决策依据

本结构的决策见归属记录：[2026-10-16 e2ee-core 服务架构](../../../.agents/notes/implemented/architecture/2026-10-16-e2ee-core-service-architecture.zh.md)。更早的协议与持久化决策：[当前决策](../../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.zh.md)。

## 浏览器曲线与所有权

可选浏览器适配提供独立的 JS Ed25519/X25519 能力，不改账本 v1 或 epoch HPKE
算法、域与 AAD。Ed25519 复用已固定的 noble 后端，HPKE 使用上游固定版本的 JS
X25519 KEM。seal 无需原生 X25519；原生收件人句柄继续走原路径。WASM 不可用时，
仅明确的原生 Ed25519 不支持或缺少 SubtleCrypto 才转入固定的严格 JS 验签；签名
不匹配或其他后端故障不会选择另一套接受规则。

上游 JS key 对象的私钥字段不能通过 `CryptoKeyPair` 形状暴露。core 用私有 WeakMap
保留它，只返回冻结的元数据句柄。HPKE 借用保留私钥到实际加密工作结束，即使调用
被中断也一样。close 先禁止新借用和签名，等待已准入操作，再清理两份私钥。
克隆、混合和已关闭句柄不能继续使用；原生 key 仍走原生路径。这些句柄不具备原生
不可导出保障，也不隔离可信应用代码。平台仍负责持久 KEK 保护和设备准入。

`@hpke/common@1.10.1` 补丁仅移除两种分发格式中对 Node <=18 的动态 builtin 加载。
支持的 Node 版本均提供全局 WebCrypto；浏览器缺少它时失败，不导入 Node。算法不变。
`test:browser-crypto` 面向 Safari 16.4 打包，要求无外部导入，并在禁用原生曲线和
WASM 的 Chromium/WebKit 执行。独立 CI 任务安装两个引擎，普通单测无需浏览器。
这是桌面浏览器引擎兼容证据，不是最低 OS 真机或持久保管验收。

## IndexedDB 所有权

可选 IDB 适配器持有 Scope 内的一条连接和短原生事务，不另建验证缓存。
账号/工作区/genesis 数据库在身份替换后保留；配对位置额外绑定设备/安装。
retained 起点由既有账本流程限定后才能使用。请求 strict durability，
以事务 complete 作为可观察提交边界。关闭先拒绝新调用，再等待真实事务 Promise，
延迟 open 回调不能复活旧 owner；任何事务都不等待 crypto/network。
[服务说明](services.zh.md#浏览器账本与原件存储)解释路由、CAS 与原件保留，
归属架构 note 说明为何拒绝换设备就重建数据库。

## 浏览器持久保护

可选 browser-custody Layer 提供作用域内有限写者、持久不可导出 AES-GCM 保护和只读
身份原件。宿主先互斥再分配身份，网络等待前释放；关闭等待已准入调用及取消后仍在
执行的原生工作。短 IDB 回调在密码调用前保存意图/nonce，之后保存精确密文。
两套稳定布局将账本/原件与安装、KEK 元数据、密钥/快照 journal 分开，替换身份不删除
任何一套。这些只是本地并发和恢复证据，不是第二份账本或审批缓存。
见[保管与安装](services.zh.md#浏览器保管与安装)。
