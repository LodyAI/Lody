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
