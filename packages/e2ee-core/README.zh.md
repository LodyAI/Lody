# @lody/e2ee-core 导读

[English](README.md)

面向“经由不可信后端同步的协作文档”的端到端加密库。**签名成员账本**决定谁属于工作区、当前使用哪一个**纪元密钥**；设备之间通过不可信的邮箱互相投递这个密钥，文档用由它派生的密钥加密。后端只存储密文、转发消息，无法读取内容、伪造成员关系，也无法让设备回滚到旧账本。

这个库不绑定 Lody，也不绑定 Convex。所有远端系统、平台能力和本地存储都是由你提供的 service，因此适用于任何通过 Loro / Durable Streams 或类似追加日志同步的应用。

## 可用范围

服务架构已经支持复用，但当前仍是仓库内的私有包（`private: true`、版本 `0.0.0`），
尚未发布为独立 SDK，生产 E2EE 组合也未启用。已有 Node SQLite 与 Loro Streams
适配器；其他运行时需要实现自己的存储和平台适配器。后端端口与 `/host` 规定其他
后端需要实现什么，并不负责部署服务器。

protocol 入口还提供机器所有者签名的完整共享策略 codec、资源绑定、版本验证与纯执行
判断。`readMachineSharingHistoryStep` 可在原 personal 签名者撤销后读取历史完整状态，
供新所有者意图保留项目设置，不授予执行权。host 入口验证不解密的所有者帧，
platform/cloud-api 定义对应 CAS DTO。这些原语
尚未接入网络、UI 或执行路径；[共享策略提案](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.zh.md)
说明待批准 Spec 增量与后续宿主职责。

## 从这里开始

| 你想要… | 阅读 |
| --- | --- |
| 理解协议及其保证 | [白皮书](../../specs/e2ee/whitepaper.zh.md)（[English](../../specs/e2ee/whitepaper.md)） |
| 在应用中接入 E2EE | [服务](docs/services.zh.md) → [流程](docs/workflows.zh.md)（从 `E2eeWorkspace` 开始）→ [公开接口](docs/surface.zh.md) |
| 实现后端（邮箱、暂存、账本日志） | [后端指南](docs/backend-guide.zh.md) 与 `@lody/e2ee-core/host` |
| 在某个平台上实现密钥托管 | [`DeviceIdentity`、`KeyProtector`、`CandidateProtector`](docs/services.zh.md#平台端口) |
| 不用 SQLite，换别的存储 | [本地存储端口](docs/services.zh.md#本地存储端口) |
| 评审或修改本包 | [架构](docs/architecture.zh.md)，然后读 [AGENTS.md](AGENTS.md) |
| 看完整系统在真实故障下运行 | E2EE Lab，`packages/e2ee-lab`（本 PR 栈的后续层） |

## 入口

协议入口提供 `sealPresenceContent` / `openPresenceContent`、
`sealRpcRequestContent` / `openRpcRequestContent` 和 `sealRpcResponseContent` /
`openRpcResponseContent`，仅将现有 content v0 密码学按用途 7/8/9 组合到不透明正文。
调用方提供可信资源上下文、已安装 epoch 钥与预期签名者；辅助函数拥有并释放派生叶钥。
它们不验证 RPC 正文、请求／结果关联、presence TTL、机器绑定、账本权限或新鲜度。
开放通道前须在可信宿主落实这些门槛。重试保留返回的原帧；再次运行 seal 会重新加密。
本改动不启用产品传输。

共享签名格式为 current-only v2；每份 scope 包含 generation，即连续原子替换链的
首次机器签名公钥。`verifyMachineSharingGeneration` 通过真实账本位置验证准入原文链，
其不透明 `machineGeneration` 证据必须传给签发、打开、历史读取、宿主准入和执行判断。
移除后重新准入使用新资源，从私有默认值和第 1 版开始；原子替换保留原代次。压缩视图
若缺少这些账本检查点，需用完整已验证终点核验，不能相信服务端提示或旧策略高水位。

| 导入路径 | 内容 | 稳定性 |
| --- | --- | --- |
| `@lody/e2ee-core` | 流程（`KeyReceiver`、`EpochPublisher` 等）、它们的错误与结果、`E2eeWorkflows` | 公开 |
| `@lody/e2ee-core/services` | 需要你实现或提供的端口、端口错误 | 公开 |
| `@lody/e2ee-core/protocol` | 纯协议：字节、CBOR、账本验证、信封、内容格式 | 公开 |
| `@lody/e2ee-core/host` | 后端必须执行的规则、暂存线上格式（不依赖 Node API） | 公开 |
| `@lody/e2ee-core/adapters/node-sqlite` | 每个本地存储的 SQLite 实现、参考邮箱后端 | 公开 |
| `@lody/e2ee-core/adapters/loro-streams` | 基于 Loro / Durable Streams 控制流的 `LedgerLog` / `LedgerFeedSource` | 公开 |
| `@lody/e2ee-core/cloudflare` | 在 Cloudflare Worker 中导入一次，使严格 Ed25519 在 WebAssembly 中运行（workerd 禁止运行时编译）；其他运行时无需导入 | 公开 |
| `@lody/e2ee-core/internal` | 供本仓库测试和 Lab 使用的内部实现 | **不稳定** |

## 一屏看懂组合方式

```ts
import { Effect, Layer } from 'effect';
import { E2eeWorkflows, KeyReceiver, LedgerFeed } from '@lody/e2ee-core';
import { DeviceIdentity, KeyProtector, CandidateProtector, WorkspaceScope } from '@lody/e2ee-core/services';
import { sqliteLocalStores } from '@lody/e2ee-core/adapters/node-sqlite';
import { streamsLedgerLog } from '@lody/e2ee-core/adapters/loro-streams';

const app = E2eeWorkflows.pipe(
  Layer.provideMerge(LedgerFeed.viewSource),
  Layer.provideMerge(LedgerFeed.layer({ origin: { kind: 'genesis', record }, expected, budget })),
  Layer.provideMerge(
    Layer.mergeAll(
      sqliteLocalStores({ directory, mode: 'create-or-open' }),
      streamsLedgerLog({ stream, checkpoint, budget }),
      myKeyMailbox,        // 你的 KeyMailbox 适配器
      myStagingStore,      // 你的 EpochStagingStore 适配器
      myPublicationSource, // EpochPublicationSource
      KeyProtector.layerFromPromises(nativeInstalledKeyProtection),
      CandidateProtector.layerFromPromises(nativeCandidateProtection),
    )
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(WorkspaceScope, { genesis }),
      Layer.succeed(DeviceIdentity, { signer, encryptionKeyPair }),
    )
  )
);

// 有限的步骤；何时执行由应用决定。
const onStartup = Effect.gen(function* () {
  const receiver = yield* KeyReceiver;
  yield* receiver.resume();
  yield* receiver.fetchAndInstall();
  yield* receiver.flushReports();
});
```

## 代码地图

```text
src/
  index.ts, workflows.ts   "."         流程与组合
  services/                "/services" 端口
  protocol/                "/protocol" 纯协议汇总
  host/                    "/host"     后端合同
  adapters/node-sqlite/    SQLite 存储、参考邮箱后端
  adapters/loro-streams/   Streams 账本日志与 feed 源
  internal/                实现：foundation、crypto、ledger、keys、submission
test/                      行为测试（真实 SQLite、真实密码学、子进程）
scripts/check-public-docs.ts  JSDoc 与接口文档检查
docs/                      架构、服务、流程、公开接口、后端指南
```

协议内部的模块说明：[账本](src/internal/ledger/README.md)、[密钥](src/internal/keys/README.md)、[Streams 适配器](src/adapters/loro-streams/README.md)、[文档](src/internal/content/README.md)（英文）。

## 应该读的文档

- **协议**：[白皮书](../../specs/e2ee/whitepaper.zh.md)、[E2EE Spec 索引](../../specs/e2ee/README.md)、[基础 Spec](../../specs/e2ee-foundations.zh.md)、[原子移除](../../specs/e2ee/atomic-removal.zh.md)、[发布者密钥可恢复性](../../specs/e2ee/publisher-key-recoverability.zh.md)。
- **决策记录**：[当前决策](../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.zh.md)、[未定合同](../../.agents/notes/proposed/architecture/2026-10-15-e2ee-open-contracts.zh.md)、[服务架构](../../.agents/notes/implemented/architecture/2026-10-16-e2ee-core-service-architecture.zh.md)。
- **本包**：[架构](docs/architecture.zh.md)、[服务](docs/services.zh.md)、[流程](docs/workflows.zh.md)、[公开接口](docs/surface.zh.md)、[后端指南](docs/backend-guide.zh.md)。

## 常见问题

**需要 Convex 或 Lody Cloud 吗？** 不需要。你需要一个支持条件追加的账本日志（Loro / Durable Streams 开箱可用）、一个密钥邮箱和一个暂存存储，可以用任何技术栈实现：见[后端指南](docs/backend-guide.zh.md)。

**服务器能看到什么？** 只有元数据：标识符、纪元号、大小与时间。永远看不到密钥或明文。见白皮书的威胁模型。

**新设备如何拿到密钥？** 新设备通过一条签名账本记录被接纳；已有设备在账本中看到它后，由 `KeyDistributor` 通过邮箱给它发送信封；新设备执行 `KeyReceiver.fetchAndInstall`。

**如何加密文档？** 通过 Streams 同步 Loro 时，把 `streamsDocumentBinding` 作为文档的载荷保护；其他情况使用 `sealDocument` / `openDocument`。见[流程](docs/workflows.zh.md#文档)。

**如何换代密钥或移除成员？** `EpochPublisher.publish()` / `publishRemoving(membershipId)`。移除与换代在同一条签名记录中完成，被移除的成员不存在能读取新内容的时间窗口。

**设备在操作中途崩溃怎么办？** 每个流程在任何网络步骤之前保存原始字节。重启后调用 `resume` / `flush…`，会重试同样的字节，不会重新签名。

**如何防止回滚？** `VerifiedLedger` 持久地钉住最新验证过的检查点，并拒绝任何不包含它的视图。

**密钥存放在哪里？** 只有 `InstalledEpochKeys` 接触密钥材料。密钥块由你的 `KeyProtector` 保护、由 `InstalledKeyStore` 存储；调用方拿到的是必须释放的不透明密钥。

**所有设备都丢失了怎么办？** 密钥保存在加密 vault（恢复文件或 passkey）中的恢复设备可以接纳新的个人设备：`E2eeWorkspace.restoreFromRecovery`。见[流程](docs/workflows.zh.md#恢复)。

**有后台循环吗？** 没有。每个操作只处理有限的一页并返回 `next` 提示，何时调用由应用安排。

**一次调用可能返回哪些错误？** 方法签名列出具体错误类型，JSDoc 说明行为和所有权；每个流程导出完整的失败联合类型（如 `ReceiveFailure`）。按文档中的 tag、`reason` 或协议 `code` 分支处理。部分错误保留适配器的原始 `cause` 供本地诊断，不能直接展示或导出。

**如何测试我的集成？** 使用 SQLite 适配器、参考邮箱（`makeSqliteKeyMailbox` + `referenceKeyMailbox`），并参考 `test/` 中的测试。Lab 会端到端复现协议攻击。

## 检查

```sh
pnpm --filter @lody/e2ee-core typecheck
pnpm --filter @lody/e2ee-core test        # 包含公开文档测试
pnpm --filter @lody/e2ee-core check:docs  # 公开导出、命名空间与 service 成员
```

测试使用固定的合成向量、真实 SQLite、真实 Ed25519/HPKE 和子进程；`test/generate-*.py` 用于（可选地）重新生成向量。

[非门禁基准测试](bench/README.md)输出带环境信息的 JSON。

Streams 适配器与 Lab 使用当前 workspace catalog 版本。Node 宿主可共用
[node-custody](docs/surface.zh.md) 保管实现，并分别提供经过核对的系统包装器。

[冻结前格式审查](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-format-freeze-review.zh.md)记录账本格式的未决事项和仅支持当前版本的格式盘点。
