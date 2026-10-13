# E2EE 提交的持久恢复

Status: implemented
Translation: current

[English](2026-10-11-e2ee-pending-recovery.md)

## 摘要

条件追加的响应丢失，会让一份已签名账本操作处于结果未知的状态。本切片在发送前持久保存准确的签名字节，重启后通过已验证历史核对结果。SQLite 事务同时保存未消费终态结果、防回退检查点与删除 pending；权限始终从外部可信创世重建，不从保存的状态对象取得。真实 SQLite 故障注入和独立进程重开验证了工作流，但未启用生产宿主、认证快照、密钥备份或自动重签。

## 决定与所有权

应用 Scope 持有 SQLite Layer，关闭只释放连接，不删除 pending 或结果。
复用仓库锁定的 better-sqlite3 13.0.3 与 Effect 4.0.2，使用独立本地数据库，
不修改 CRDT/diff 表。主线尚无 E2EE journal 可直接扩展。每个创世最多保存
一个尝试或未消费结果；完整签名字节标识本次尝试，重复请求须比较全部正文。
消费准确结果后才能开始不同尝试。核心不创建运行时、定时器、后台 worker 或签名。

```text
Idle -> 验证 -> 持久 Pending（原字节）
Pending -> 回读并验证原结果
  原文已存在 -> Committed
  前驱被占用 -> Conflict（不重签）
  前驱仍是 head -> 持久验证位置 -> CAS（原字节）-> 回读验证
  读取/网络/保存失败或中断 -> 保留 Pending
Committed/Conflict -> 原子保存结果/位置并清除 Pending
Result -> 重开后重新验证 -> 显式确认消费 -> Idle
```

head/count 防止相对本机已接受证据的回退，不是权限投影或全球最新证明。
每次读取均完整验证历史，再在已认证前驱处验证原操作，包括签名者后来被撤销
的情况。终态也重新验证；伪造本地 Committed 或 Owner 对象不会获得权限。
可信远端端口须提供独立预期位置，并按 P08 规则执行 CAS 准入；本切片不解决
磁盘被替换或不诚实的新鲜度来源。

## 取舍与缺口

复用 CRDT/diff 表会混合所有权和持久化契约；仅内存 journal 无法跨进程退出。
导入候选状态会暴露旧 journal 的信任边界，本切片直接调用已合入 P08 验证器，
没有任意状态导入。拒绝外来/旧数据库。本地表结构不是恢复库或线上协议格式，
不改变 P12 原子移除编码。

认证快照的信任与续读契约尚未进入 main，因此不开放该恢复入口。缺历史、坏签名、
未知记录或回退均停止，不用新 checkpoint 跳过证据。当前依赖完整保留历史。
分页原子持久、创世创建、持钥/备份、后续分发与生产 Convex/Streams 接线均留给
后续切片。尚无 Electron/CLI 产品调用；实际本地进程入口
`test/submission/reopen.ts` 已组合工作流与真实持久后端。

## 来源与验证

实现基线为 `f1ba33a61244e2da07aaea93a30f06227311c4b6`，仅在 P08 #1418
实际合入后 fetch；其中也包含 P07-b #1417。未复制未合入分支或候选 journal。
[来源指纹](../../../../packages/e2ee-core/src/submission/provenance.json)记录已合入
依赖闭包与新实现文件。候选 core 7 项和 Lab 2 项历史失败未重跑、未关闭。

包类型检查与 100 项测试通过，其中 15 项提交测试覆盖原生合成签名、独立 Node
进程在 CAS 前/持久 CAS 后回复前退出、原字节恢复、不同正文重复请求、冲突和
已撤销签名者、未确认追加、SQLite 首次保存/终态保存失败、不可读/错创世/坏历史、
伪造终态、回退、并发任务替换、Scope 中断与关闭。断言观察持久数据、已验证结果
和最终历史，不以 mock 次数代替行为。

本包保留 Vitest 3.2.4；@effect/vitest 4.0.2 要求 Vitest 5，因此使用现有 runner，
配合 Effect.scoped 与 Deferred 明确信号，不升级锁定版本。新 clone 最初须先构建
锁定 ACP core，根检查才能构建 Codex。全仓类型/lint、格式、文档与全部静态边界
检查通过；默认完整 pnpm check 因七项 shared socket 用例 listen EPERM 失败，
对应两个套件在本地权限下 14/14 通过。补跑 CLI 3711 通过、四项原有跳过，
UI 300 与 turn-diff 31 通过。Electron 有 11 项沙箱 socket/下载失败，对应三个
套件在本地权限与隔离 npm 缓存下 20/20 通过。保留原完整检查的失败状态，不
重标为全绿；CI 在 PR 中跟进。
定向测试和 CI 不等于生产、安全审查、用户安装端或全平台验收；额外独立高风险
审查由协调方另行安排。

## 已合入 main 的组合

[PR #1434](https://github.com/LodyAI/Lody/pull/1434) 使用正常 merge 保留原 P09
实现、测试和来源指纹。最终整合输入为 #1432/#1433 实际合入后的
`37cadfbcb0fa2183a98ccf041ba3820a8945b28e`。AGENTS/README 冲突保留 HPKE 与
submission 两侧块；manifest 保留双方入口和依赖。Frozen 安装、core typecheck
及 128/128（含原15项恢复）、SDK transport/cursor 43/43、静态/公开边界通过。
本轮完整本地检查保留一项无关 Git helper `context_unreadable` fixture 失败
（CLI 3723通过、四项跳过），不称完整门禁绿。准确 head 的 Linux CI 与 reviewer
增量复验在 PR 跟进；旧审查仅覆盖旧 head。未改生产接线或恢复约定。
