# @lody/e2ee-core 交接摘要

日期：2026-09-13  
完整报告（含证据表、Lean、宿主清单）：私有 `plans/20260913-e2ee-independent-package-handoff.zh.md`  
规范：[ledger spec §§8–11](../../specs/e2ee-ledger.zh.md) · 调用示例：[README.md](README.md)

## 状态

独立 DAG-CBOR 账本已实现并 git freeze，**未 push、未开 PR、未启用产品 E2EE**。

- 分支：`feat-e2ee-core`
- 实现：`147e8224c83c3753a7c81e59377ecbf50a47fdad`
- tip（README 绑定）：`4074069c3be3ebc6f1c3711ec0d1691db4df94ec`
- ledger concat SHA-256：`c5f51a0bd4323ff53e86d1ec0cea6d2912e62aa7f383197d933f992a01a6dd56`
- `pnpm --filter @lody/e2ee-core check`：typecheck + 328 tests

可以独立创建/验证/对账/提交账本、发钥换代、用恢复文件解锁并授权新设备。  
**不是** Lody 产品已支持 E2EE。

未勾、不放宽：

- **B**：10k 条从零 parse+hash+全部验签+权限重放，目标热 p95 ≤100ms。实测 Node ~2.7s（~27×）、Chromium 99 ~95s（~952×）。
- **R2 / C3**：Passkey PRF 与真机浏览器。文件恢复路径已测；本环境无成功 PRF、无 USB 真机。
- 生产 Loro Streams `/append-cas` 仍为 **501**（本地官方 sqlite-riverrun 已测 CAS）。

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

| 入口 | 用途 |
| --- | --- |
| `@lody/e2ee-core` `Ledger` | 外带 genesis hash 做 `verify` / `extend`。禁止 `verified=true` |
| `@lody/e2ee-core/ledger` | 编解码、历史包、HPKE、`LedgerClient`、`LedgerKeyDelivery` |
| `@lody/e2ee-core/streams` | Durable Streams 适配；CAS 用 `appendCas`，不要普通 append |
| `@lody/e2ee-core/streams-content` | streams-crdt；无 snapshot provenance 则 fail-closed |
| `createRecoveryFile` / `sealRecoveryBackup` | 文件包装不透明字节（不是可导出 R 私钥） |
| `@lody/e2ee-core/ledger-node` | 实验 sqlite journal/outbox，不是冻结格式 |

JSON/hex 原型不在公开入口（`src/legacy.ts` 仅包内测试）。

Owner 转让（D1 A）是单方的：`[6, successorMembershipId]`，前任变 Admin。  
`openEpochEnvelope` 只在 epoch 匹配且 `commitEpochKey` 等于账本承诺时返回明文。  
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
4. 读回磁盘后再次 `Ledger.verify`  
5. 真机 Passkey PRF（若产品要这条恢复路径）

下一步产品接线、Convex、启用开关需要 **另行授权**。
