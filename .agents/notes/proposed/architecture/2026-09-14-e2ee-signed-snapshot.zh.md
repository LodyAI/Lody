# 签名权限快照引导（S1 提案，尚未确认）

Status: proposed
Translation: pending

## 摘要

正常首次加入将验证外带认证设备签署的权限快照，再逐条验证增量；完整历史改为可选审计。快照不是账本 op，也不能凭内部自称 Owner 建立信任。2026-09-14 Zixuan 确认推荐方案，并要求外带最新 head 及其签名（担保该版本及此前版本）。`Ledger.verifySnapshot` 已开始落地；S3–S5 未完成。不得把现有 `Ledger.verify` 或内容 CRDT snapshot 当作该入口。解开恢复设备私钥不能授予快照可信性。旧 10k/100ms 门槛已撤销，不是通过。

## 已确认入口（S2 落地中）

信任输入为调用方提供的 `genesis`、`endorser`、担保的最新 `head`，以及 endorser 对该 head 的签名。加入背书者限于声称状态中当前有效的 Owner/Admin 个人管理设备。签名覆盖完整授权状态、防重放集合（曾用签名/加密公钥、曾用 membershipId、已消费 join）、内嵌历史密钥包、位置与 head。调用：

```ts
const snapshot = await Ledger.finalizeSnapshot(
  ledger.prepareSnapshot(endorserPublicKey),
  signature
);
const joined = await Ledger.verifySnapshot({
  trust: {
    genesis,
    endorser: endorserPublicKey,
    head,
    headSignature,
  },
  snapshot,
  suffix,
});
// joined.origin === 'snapshot'；无 verified 字段
const next = await joined.extend(more);
Ledger.compareNotes(localNote, remoteNote, { originalEndorser });
```

`compareNotes` 区分不同 Org、待同步（length 不同）、同位置一致、同位置冲突。原邀请者再签不得标独立核对。结构合法的虚假状态若由已认证背书者签署，验证器接受并保持尚未独立核对。

完整字段见公开 `specs/e2ee-ledger.zh.md` §6.1。关联：[账本规范 §6.1](../../../../specs/e2ee-ledger.zh.md#61-签名快照引导已确认方向尚未实现)、[控制账本笔记](2026-09-12-e2ee-control-log.zh.md)。
