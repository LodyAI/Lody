# @lody/e2ee-core 交接摘要

日期：2026-09-13  
完整报告（含证据表、Lean、宿主清单）：私有 `plans/20260913-e2ee-independent-package-handoff.zh.md`  
规范：[ledger spec §§8–11](../../specs/e2ee-ledger.zh.md) · 调用示例：[README.md](README.md)

## 状态

2026-09-21 修订：设备持钥证明升级为 `possess/v2`，必须绑定目标 membershipId；旧 v1 证明不再接受，不做自动迁移或双版本降级。旧账本含 admitDevice 时不能直接全量重放；快照背书仍不等于验证历史证明。详见规范 §8.2。快照导入拒绝 machine/recovery 的管理位，但保留降级到 Guest 后已有设备的合法状态。

发布范围说明（2026-09-14）：本次提交只更新设计文档。下文两进程 R 恢复、Lean 对照及部分探针的修复报告涉及尚未提交的本地代码，不随本次文档提交交付；接手者必须先以实际 checkout 的 exports/测试核对，不能假设这些修复已在远端。旧“未 push”描述保留为历史时间点，不作为当前远端状态。

独立 DAG-CBOR 账本已实现。**代码 freeze 不是验收完成，也不是人类同意交接。** 未 push、未开 PR、未启用产品 E2EE。

- 分支：`feat-e2ee-core`（相对 review 基线 `795ee4a` 有本轮修复）
- **P3/P4 总项未通过**

可以独立创建/验证/对账/提交账本、发钥换代。恢复设备 R 的 **文件备份双进程** 路径已测（`createRecoveryDeviceSecret` / `importRecoveryDevice`）。
**不是** Lody 产品已支持 E2EE。

**后续设计决定（快照阶段已落地，不是 V4）：** 正常首次加入验证认证设备签署的权限快照，之后逐条验增量；全量历史保留供审计。入口 `verifySnapshot` / `openFromSnapshot` 已在 `70ffef7` 落地。核对必须绑定实际权限状态及链头，邀请者背书不等于独立核验全部历史。见[规范 §6.1](../../specs/e2ee-ledger.zh.md#61-签名快照引导)。真机 Passkey 仍待验收。

仍待验收或已撤销：

- **B 已撤销，不是通过**：原 10k 从零全签重放热 p95 ≤100ms。Node ~2.7s（~27×）、Chromium ~95s。OpenSSL 原生验签在 800 次合法签名上约 20× 快于 noble，外推仍高于 100ms；未替换 Ledger.verify（语义需单独审查）。
- **S**：快照资格与格式、纯验证 API、两端独立核对、持久化/历史密钥/R 恢复及独立消费者已整理于 `70ffef7`，不是 V4、不是 merge/push。停止为旧 B 门槛安排 SIMD/Wasm/多线程优化。
- **R2 / C3**：后续验收阶段。Passkey PRF 与真机仍未验。无 mock。
- **R3**：文件双进程已测（含撤 R、成员失效、缺包、坏备份）；PRF 未过。krc-loop 内存 R 与擦公钥不算「仅凭备份恢复 R」。
- **C2**：公开包部分串联，不是完整备份恢复。
- **M2 / M3**：有限模型 + `lake exe correspond` 投影对照 `Ledger.state`（`replay`/`unauthorized` 已断言），不是协议证明。公开仓默认不读作者家目录；设 `LODY_E2EE_LEAN` 或使用兄弟目录 `lody-e2ee-design/proofs/e2ee`，否则跳过 `lake` 步。
- **V4 / P4**：代码 freeze 不是验收完成，也不是人类同意交接。
- 生产 Loro Streams `/append-cas` 仍为 **501**。

## 接入者用这些入口

```ts
import { Ledger } from '@lody/e2ee-core';
import {
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  signingBytesForBody,
  LedgerClient,
} from '@lody/e2ee-core/ledger';
```

| 入口                                                  | 用途                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `@lody/e2ee-core` `Ledger`                            | 外带 genesis hash 做 `verify` / `extend`。禁止 `verified=true` |
| `@lody/e2ee-core/ledger`                              | 编解码、历史包、HPKE、`LedgerClient`、`LedgerKeyDelivery`      |
| `@lody/e2ee-core/streams`                             | Durable Streams 适配；CAS 用 `appendCas`，不要普通 append      |
| `@lody/e2ee-core/streams-content`                     | streams-crdt；无 snapshot provenance 则 fail-closed            |
| `createRecoveryFile` / `sealRecoveryBackup`           | 包装不透明字节                                                 |
| `createRecoveryDeviceSecret` / `importRecoveryDevice` | 生成可导出 PKCS8，日常导入为非导出句柄                         |
| `@lody/e2ee-core/ledger-node`                         | 实验 sqlite journal/outbox，不是冻结格式                       |

JSON/hex 原型不在公开入口（`src/legacy.ts` 仅包内测试）。

Owner 转让（D1 A）是单方的：`[6, successorMembershipId]`，前任变 Admin。  
`openEpochEnvelope` 只在发送者是当前有效的非恢复设备（任何个人/机器设备都可转发，R 只收不发）、收件人在账本上、epoch 匹配且 `commitEpochKey` 等于账本承诺时返回明文。
冲突不重签：`prepare` → 落盘精确 pending → CAS → 读回原文。

## 试接

```sh
pnpm --filter @lody/e2ee-core exec tsx bench/readme-consumer.ts
pnpm --filter @lody/e2ee-core exec vitest run test/ledger-consumer.test.ts
```

期望：`verifyLength: 1`、`extendLength: 2`、`transferLength: 4`、`fromZeroMatchesExtend: true`，consumer 1 passed。

## 宿主必须自备

1. 外带确认的 genesis hash
2. 原子 Streams CAS（生产网关目前 501）
3. JWT/网关 15 分钟新鲜度；不要把 JWT 过期说成旧钥失效
4. 当前入口读回磁盘后再次 `Ledger.verify`；未来快照恢复须验证认证材料与后缀，不能直接信任磁盘状态或 `verified=true`
5. 真机 Passkey PRF（若产品要这条恢复路径）

下一步产品接线、Convex、启用开关需要 **另行授权**。
