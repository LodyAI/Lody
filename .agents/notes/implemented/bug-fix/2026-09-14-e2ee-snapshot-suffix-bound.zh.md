# 快照后缀对任何不能接上认证链的记录必须 fail-closed

Status: implemented
Translation: current

[English](./2026-09-14-e2ee-snapshot-suffix-bound.md)

## 摘要

快照刷新可以跳过见到 attested head 之前的流前缀。边界之后后缀是哈希链：不能接到 attested head 的记录必须 fail-closed，且不得推进 journal 游标。`64aff08` 堵住了普通记录的 wrong-parent 跳过。其后 `genesis` 的无条件 `continue` 仍会在合法快照读取后跳过另一 Org 的创世记录并推进游标。刷新现在在边界后拒绝外来 genesis 和已见过的重复 hash；前缀跳过和空尾页仍被允许。

## 决定与范围

边界在页内用内存标记，仅在成功处理到 head 或接上后缀的页之后写入 journal `snapshotBound`。失败不保存该页：offset、records 与 pending 保持原值。未知前缀只用本地读游标跳过，直到见到 head；不得把「垃圾页 + 空尾页」写成已追上。从创世打开的客户端仍跳过自己已验证的 hash。无第 8 元 `true` 的 v1 journal 仍可读。

不改变快照信任（DEC-001）、Passkey/真机验收（DEC-002）、生产 CAS，或内容快照出处绑定。

## 证据与取舍

独立输入：合法 `openFromSnapshot`/`read`，再追加另一 Org genesis，再 `read`。在 `64aff08` 上第二次 `read` 成功且游标越过外来记录。预期：`wrong-parent`，游标不变。普通 wrong-parent 回归仍通过。

删掉全部 `continue` 会把诚实前缀当成错误。保留无条件 genesis 跳过会重开漏洞。用 `wasBound` 区分前缀跳过与边界后 fail-closed。

回归：`test/ledger-snapshot-client.test.ts`（同页/跨页/重启/缺边界/空尾页/坏记录后接合法后缀/重复已知 hash）以及 `test/ledger-node-store.test.ts` 的 sqlite v1 7 元兼容。丢失 ACK 与精确字节 CAS 仍由 `test/ledger-submit.test.ts` 覆盖。
