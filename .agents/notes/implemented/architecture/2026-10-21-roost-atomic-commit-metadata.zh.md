# Roost 本地提交元数据

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1791
Companion: https://github.com/loro-dev/roost/pull/21

[English](2026-10-21-roost-atomic-commit-metadata.md)

## 摘要

流式通知目前分别写原生事件与 renderer 凭据，重复保存游标和 scope。
本修改把 renderer 摘要附着在原生事务的最后一个事件上，每个 stream 只绑定一次完整 scope。
agent 查重摘要保留直接索引，并增加事务内不存在检查。实现与验证完成：1024 次通知的
数据库净增量减少约 21%，变更读取约快 39%，写入总耗时约增加 1.1%。
这不是零回归保证，也未达到 Loro 的体积；Lody 草稿仍依赖尚未发布的 Native API。

## 决策

Native 负责正文、索引、摘要的原子落盘和准确事件区间；Lody 负责业务 ID、结构位置、
nonce 与覆盖验证。原始更新继续按 TurnID/seq 连续存储，避免同步逐条间接回查。
没有摘要的事件仍是缺口，不能证明覆盖完整。Native 只在事件增量等于 local refs 加实际索引
事件时证明摘要覆盖；顺带接纳远端 pending 更新时不附着摘要。连续的完整摘要区间允许
热路径省去原先额外的事件扫描。热路径 patch 原子附着摘要；复杂 SDK 操作
仍须证明整个区间，否则返回 reset。Loro 控制文档仍是独立发布事务，通过已有持久历史恢复。

renderer v3 内容只保存版本、标志、完整 nonce、无损 ID 列表与可选结构位置；Native 保存
before/through 和完整 scope。拒绝旧 renderer 索引格式，不迁移、不删除。
agent v2 保留完整身份与摘要，包含不修改正文的操作。不裁剪历史、不等待凑批、不降低
持久性、不用历史回放替代索引。[原 renderer 决策](../bug-fix/2026-10-21-roost-renderer-receipt-encoding.zh.md)
提供基线与继续保留的 checkpoint 保证。

Effect feature/fix 评估：保留当前 Promise Native owner；生命周期迁移会跨越未完成的
Session 依赖，不能帮助本次存储合同。codec 保持纯 TypeScript。

## 验证与发布

真实 Native 的四个 owning suites 共 106 项通过。包括丢回复后的重试及重开增量读取、
同 ID 不同摘要拒绝、只写凭据的 CAS、跨 128 原生事件页的批次、未附摘要的缺口、generation
与 nonce、损坏数据、旧/混合格式原样拒绝。Rust 365 项通过、6 项原有 ignored；Native 53 项
通过。打包后的 SQLite v8 重开与加密同步 smoke 通过。pending 远端工作与本地写入合并时，
Native 不附业务摘要；Lody 必须走完整覆盖校验或 reset。

CLI 类型检查、公共边界、格式检查、改动范围 type-aware lint 通过（lint 有 84 项警告）。
文档检查 0 错误、71 项已有警告。根 pnpm check 在未改动的 site-docs/fumadocs pretypecheck
报 Class extends undefined，不能宣称全仓检查通过。Effect 生命周期未扩展。

Linux 2 vCPU / 7.5 GiB、Node 24.22；基线 Lody e920a78 / Roost 60f6b16。
使用两个可见消息、40 个已完成合成工具，逐条追加 224/1024 次文本通知并读取 checkpoint；
全部历史保留，每轮新库/进程，丢弃热身后交替执行四对，表中取中位数。时间测量不混入 Loro
对照写入。SQLite 净增量以 page_count × page_size 减空库计算，不含 WAL 文件大小。

| 指标 | 224 基线 → 候选 | 1024 基线 → 候选 |
| --- | --- | --- |
| SQLite 净增量 | 212 → 188 KiB（−11.3%） | 642 → 508 KiB（−20.9%） |
| 写入总耗时 | 4070.80 → 4079.98 ms | 19548.27 → 19768.99 ms（+1.1%） |
| 单次写入 p95 | 24.92 → 24.76 ms | 25.02 → 25.42 ms |
| 变更读取 p50 | 7.74 → 5.31 ms | 27.22 → 16.57 ms |
| 变更读取 p95 | 9.48 → 7.05 ms | 33.07 → 19.68 ms |
| 重开读取 | 92.43 → 86.23 ms | 94.23 → 87.27 ms |

1024 的配对写入时间变化范围 −3.22% 到 +4.15%，CPU 中位数增加约 1.9%；不能保证零性能
风险。混合测试进程 RSS 没有减少，也不能当作部署 CLI 内存。224 次通知的独立 strace
测得 WAL 写入 14325368 → 12516688 B（−12.6%），commit frame 1369 → 1145；
包含 fixture 设置/重开/重试，strace 时间未参与上表。修正 -xx 文件路径转义解析后统计，
初次错误的零值不作为证据。

Loro 1.16.3 独立同内容存储对照保留全部增量：224 为 76 KiB，1024 为 200 KiB；同次
Roost 候选为 188/516 KiB。所有可见 checkpoint、重开、重放去重检查通过，但输入来自
Roost checkpoint，并非独立业务 oracle；Loro 对照未实现全部 agent/renderer 合同。
Roost 原始 update value（1024）为 138086 B，对应 Loro 全增量 139240 B，wire 没有因本项
变小。磁盘仍约为 Loro 的 2.5 倍，不能声称体积问题已解决。

## 发布边界

Native `commit-metadata-v1` 使用 fresh/SQLite v8，无旧 reader、迁移或自动删除。
主 `@loro-dev/roost-node@0.2.0` 尚不提供本 API；验证只在隔离 checkout 链接候选 JS/types
和本机/Linux addon，未更改共享 pnpm store。草稿禁止合并，直到维护者统一发布 Roost，
随后更新精确依赖和锁文件并用正式包复核。没有修改当前 CLI、staging、npm 包或已有测试库。

## 压缩存储验证跟进（2026-10-22）

Roost 拟议的 SQLite v9 将保留的 updates/events 装进压缩块。流式回归原来把 SQL 行数
当成操作数量，并统计编码后的凭据 bytes，因此即使完整历史仍在，新物理布局也会让断言
失败。现在改用 Native Turn 序列总数、导出的更新 bytes 和解码后的索引记录，保留原来的
1 MiB 历史上限、128 条完整的 82-byte 凭据、不变大字段内容以及重开/重试检查。投影布局
未变，仍检查物理记录数量。seal 后状态更新回归也改用 Native 逐条导出：原 SQL 查询
对压缩块返回空结果，会让不可改写检查空跑。两项测试均验证完整解码及非空历史；保留
旧更新字节不变、不写入 sealed Turn、新增总量与单条大小边界，不放宽断言适应压缩。
这次只改测试，同时适用于 v8/v9 候选，不添加运行时格式读取、
依赖更新或迁移。上述发包和精确依赖更新仍是独立发布步骤。

配套实现：[Roost #22](https://github.com/loro-dev/roost/pull/22)。四个 suite 在两版候选
addon 上均为 106 项通过。CLI 类型、定向 lint 和格式检查通过；docs check 为
0 errors / 71 既有 warnings。指定候选 addon 的 root check 被上述未改动的
site-docs/fumadocs pretypecheck 错误阻塞，未记为通过。
[PR #1800 静态 CI](https://github.com/LodyAI/Lody/actions/runs/39695502246/job/119551749710)
另确认了发包门槛：当前锁定的正式包缺少父 PR 使用的 `readCommitMetadata`、
`annotateCommit`、`commitMetadataAfter`、`expectedIndexes` 和 `commit-metadata-v1`。
这些生产源码本次未改。合并前须统一发布 Native、更新父 PR 的精确依赖和锁文件；
候选链接测试通过不代表使用正式注册表包的 CI 已通过。

长会话补验发现测量方式的问题：同进程另一份 SQLite 库不能打开再关闭仍由 Native
持有的数据库文件，否则可能释放 owner 的 POSIX 锁。剩余的物理投影行数断言现在由
独立 Node 子进程查询；Native client 保持打开，原非空及数量边界不变。手动 benchmark
也改为这种分离方式。只改测试工具，不改变运行时存储或历史行为。长负载结果与作废的
首轮 SIGBUS 实验记录在 Roost #22 的 owning note。
隔离修正后，会话 backend owning suite 在 v8/v9 addon 上均为 88 项通过；root format
通过。root check 仍被上述既有 site-docs pretypecheck 问题阻塞。

更正（2026-10-22）：上述 site-docs 错误来自为整个 workspace 设置通用的
NAPI_RS_NATIVE_LIBRARY_PATH，导致 Rolldown 加载了 Roost 二进制，不能认定为独立的
基线 bug。[owner 投影调查](../../proposed/architecture/2026-10-22-roost-owner-incremental-projection.zh.md)
记录了清除全局覆盖后的验证。Native 尚未发布的 API 及协调发包要求仍然存在。
