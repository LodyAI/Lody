# 内容快照与权限账本快照背书分离

Status: implemented
Translation: current

[English](./2026-09-14-e2ee-content-snapshot.md)

## 摘要

文档内容快照复用 streams-crdt 已有 `PayloadProtectionProvider.seal/open`（`update_batch` 与 `snapshot`）。有文档写权限的设备（含机器）可签署；Guest 不可。这不是权限账本背书。发表证据是宿主在 continuation offset 接纳的快照字节，截止仍是既有最坏 15 分钟后端信任；作者随后被撤不使该已接纳快照自动失效。无跨流事务，不自动裁剪账本历史。

## 决定与范围

streams-crdt 仅在 snapshot 的 seal/open 传入不透明 `continuationOffset`。update_batch 的 context 与 envelope AAD 不变。Lody 在现有内容帧内绑定 Org/genesis、resource、kind/model、epoch 与该 offset。打开已接纳快照不再查当前写权限。生产网关 JWT 截止仍未验。

## 证据与取舍

Provider 测试覆盖写者/Guest、offset 不匹配、篡改、缺代钥、设备写权限查询。C1 HTTP 快照+后缀 bootstrap 在存在兄弟仓 `@loro-dev/streams-crdt` 源码时走该实现（`LORO_STREAMS_CRDT` 或 `../../../loro-streams/packages/streams-crdt`）。已发布 catalog 0.15.1 不会把 offset 传入 snapshot encode/decode。
