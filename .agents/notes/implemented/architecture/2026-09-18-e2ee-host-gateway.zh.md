# 诚实宿主 ACL 是 sqlite Riverrun 前面的网关

Status: implemented
Translation: current

[English](./2026-09-18-e2ee-host-gateway.md)

## 摘要

E2EE 实验室的云端 ACL 放在官方 sqlite Riverrun 前面的薄 HTTP 网关里，而不是 Riverrun 表。Riverrun 只存密文并做 CAS，不得决定 Owner、Guest 或 `canManage`。Lab 宿主现在现读已验证控制账本，再套合成员、`deviceMayWriteDocument` 和 `canSendEpoch`。直连 `riverrunUrl` 仍无鉴权，恶意服务器测试才能继续打客户端防线。这是未实现的生产 JWT/网关的本地替身，不是产品 E2EE。

## 决定

白皮书 A5 已把 Streams 的完整/CAS 与 JWT 云端准入分开。实验室曾把两者都塞进 `startDemoHost`，并把 `credential.genesisHex == null` 当成任意流可读。

网关（`packages/e2ee-lab/src/platform/gateway.ts`）是诚实宿主的鉴权层：

1. 只有设备已在该 Org 当前账本上，才签发绑定该 Org 的凭证。仅持钥证明只发未绑定登录令牌。
2. `/ds/` 与仅成员元数据：经 Riverrun 读控制流，`Ledger.verify`/`extend` 后再判定。授权不用粘性成员缓存。
3. 读取要求当前设备在账本上。内容写用 `deviceMayWriteDocument`。密钥流写用导出的 `canSendEpoch`。控制流 CAS 仍检查记录签名者等于凭证设备，且 `extend` 成功。
4. 快照 PUT 仍走 `createContentSnapshotPublication`。`mayWriteDocument` 从 `AsyncLocalStorage` 读本请求账本，不用进程全局 genesis。
5. 攻击辅助继续无 ACL 写 `riverrunUrl`。宿主 403 不能当成客户端完整性通过。

Host-meta SQLite（凭证、空间、申请/对账信箱）是网关自己的状态，不是第二份权限账本。

## 否决的替代

把角色和成员列写进 sqlite Riverrun。那会让存储变成第二套策略引擎，与签名账本分叉；对 Riverrun 字节做 xor/追加的恶意服务器测试也不再表示「绕过权限层」。

## 限制

不是生产 JWT 签发。15 分钟租约仍是最坏残留窗口。快照准入在异步验签期间仍可能与撤权竞态。`open` 仍不复查当前写权，所以恶意 Riverrun 下 guest/已撤密文仍是 `outside-model`。生产网关应复用同一套核心判定，而不是再建角色表。

相关实验室工作：[攻防实验室笔记](../../proposed/testing/2026-09-16-e2ee-adversarial-lab.zh.md)。
