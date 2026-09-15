# 独立 E2EE demo 包

Status: proposed
Translation: current

[English](./2026-09-16-e2ee-independent-demo.md)

## 摘要

产品 E2EE 接线已暂停。下一步可执行证明是本地独立 demo：在当前
`feat-e2ee-core` 分支新增 `packages/e2ee-demo`，用 loopback Node 宿主、官方
SQLite Riverrun（显式数据目录）和隔离浏览器客户端，只通过公开
`@lody/e2ee-core` 与 streams-crdt API 协作。这不是 Lody 接入、V4 或生产启用。
npm `streams-crdt@0.15.1` 缺少快照 `continuationOffset`，因此 demo 固定带校验
的本地 tarball，而不是兄弟源码 alias。

## 决定与范围

- 在本仓库、本分支开发。不新建 `codex/e2ee-demo`、`examples/e2ee-demo/`，
  不在 `/tmp` 长期开发。
- core 不依赖 demo。demo 不导入 Electron、Convex 或 Cloudflare。
- 控制写先验签和当前权限，再 CAS。CAS 前持久保存精确 pending 字节；丢 ACK
  靠读回确认，不重签。pending 不是已提交权限。
- HTTP 凭证保存原始 `expiresAt`。缓存、排队、重启不得续命。`now == expires`
  视为过期。
- 历史已接纳快照在作者后撤后仍可读。撤权不擦除对方已获得的 epoch 密钥。
- 恢复备份 v2 用 `sealRecoveryBackup` 封装 R 私钥与 epoch 密钥表。恢复必须
  `committed` 接纳新设备并解密历史密文，不得伪造身份或明文存放 R。
- 摘要不一致是 `conflict` / `inconsistent`，绝不是 `checked`。
  `pending-sync` 不是核对成功。

## 限制

生产 JWT 网关提交 `60610126` 在另一棵树；demo 在自有 Node 路径执行截止。
Demo 完成不等于产品启用。npm `streams-crdt@0.15.1` 仍缺 `continuationOffset`，
继续使用固定 tarball。同一 `StreamsCrdt` 实例在 `sync()` 之后不能再
`appendWriteOnly`。
