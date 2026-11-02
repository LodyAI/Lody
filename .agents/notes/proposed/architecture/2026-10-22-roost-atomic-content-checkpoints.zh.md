# Roost 正文的原子检查点

Status: proposed
Translation: current

[English](2026-10-22-roost-atomic-content-checkpoints.md)

## 摘要

普通追加仍有四次 SQLite 事务：正文/收据、绑定进度、发布进度、goal 投影。
使用用户刚批准的 Native 条件派生索引组，在 SDK 证明已结清的已发布正文编辑、
Native 证明实际事件区间完全属于本批时，将其合并。其余情况保留完整追赶和
原 goal 持久化。实现与同内容持久化 Loro 对照尚在进行，没有发包或部署。

## 计划与验收

SDK 拥有私有检查点格式、绑定/成员验证与等待发布依赖。Lody 提供普通收据及
单独暂存的 goal 投影，暂存不能修改当前内存状态。仅确认精确区间的
`derivedIndexesApplied` 结果后，才能跳过后续 goal 单独事务；不能用
metadataAttached 代替。发布仍验证全部实际事件，遇远端或不确定工作重载。
未知 goal、非正文命令、封口、等待依赖及远端事件保持原恢复路径。

明确要求匹配的 Native 能力，不增加旧存储读取/迁移、不削弱同步/签名、不裁剪
收据、不推迟持久化。保持生命周期边界，本次小范围纯计算/Native 边界修改
不需要 Effect 迁移。测试真实 Native 的正文/goal/收据恢复、丢回复、远端竞争、
语义失败及重开状态，运行根 format/check/docs check。独立草稿 PR 叠在 #1807，
配套 Roost API PR。在 Linux 研究 checkout 将完整 WAL/FULL 操作与上一版及
相同内容的持久化 Loro 对照。

## 进度

2026-10-22：用户明确批准 Native 原子合并和正确性/速度实测。Core/Native SDK
已通过精确事件区间、pending 远端更新、未来发布依赖、事件游标竞争和丢回复后
重开的行为测试。Lody 消费端从此开始，Roost 记录在
`2026-10-22-atomic-derived-indexes.md`。最终检查和实测未完成。


### 接入检查点

四组真实 Native 专属套件 112 项通过。新增测试确认正文/收据/active goal
提交后丢回复，重试/重开不重复追加，且仍禁止删除 active goal。已有 owner
竞争用例现在先实际提交原子组，再由 peer 修改较早的 goal；发布会重载并保留
peer 的 active goal。

goal 暂存和实际更新共用纯 reducer；单独克隆 goal 快照并绑定提交前 host，
不能用不同 generation 上恰好相同的数字游标跳过持久化。SDK 也在首次 await
前拥有操作/options 的字节。未知/远端工作没有被视为成功。CLI 配置的
`pnpm run typecheck` 通过；误用通用 `tsc --noEmit` 会包含开发测试/桌面配置并
出现既有无关类型错误，它不是此仓库的验收命令。根 format/check 和 docs
检查仍在进行。

100 次小追加产生 100 次 Native writeBatch（此前为 200 次 writeBatch + 200
次索引 compare/write），索引读取 2200→1300、事件读取 800→500。全部 100
组都带 SDK 进度及应用 goal。独立 Loro 控制文档的持久化保持不变。请求追踪
不是速度对照；两组完整 Linux 配置及持久化 Loro 的矩阵仍在运行，初步速度
不作为最终结论。


## 最终实测与验证

配套 API：[Roost #25](https://github.com/loro-dev/roost/pull/25)，叠在 Roost #24；
本 Lody PR 叠在 #1807。需要尚未发布的匹配 Native/SDK 包，未改清单/锁文件去
引用虚构版本。本地使用独立候选包，不修改 pnpm store。

Linux 有效矩阵 30 阶段全部通过：10 组写入/重开/分页，Roost 每变体两次，顺序
before/after/after/before；每个场景各有一次 Loro 参考。双方 WAL/FULL、每次
操作等待持久化。完整业务内容摘要与 Loro 相同，重开摘要与写入相同，18 次
关闭后 SQLite quick_check 通过。实测 Rust、Native JS、SDK JS 及四个 Lody
运行时文件与最终源码逐字节一致。研究源码/包链接或目录全部恢复，临时 harness
删除。

| 场景 | 优化前追加 p95 | 优化后追加 p95 | 持久化 Loro p95 |
| --- | ---: | ---: | ---: |
| 100 轮 / 200 消息 / 2000 × 256B；assistant 各含 16 KiB 工具结果 | 25.70 ms | 13.16 ms | 4.00 ms |
| 单回复 1000 × 1 KiB + 16 KiB 工具结果 | 33.09 ms | 25.88 ms | 13.55 ms |

追加总时间分别为 35.43→19.41 秒 / Loro 5.08 秒，及 23.89→16.94 秒 /
Loro 8.45 秒；追加 CPU 分别为 17.03→12.97 秒、17.65→15.04 秒。p95 降低
49% / 22%，尚未达到长会话超过 Loro 的目标。多消息新消息创建 p95 为
109.45→105.04 ms，Loro 4.63 ms；总分页 0.621→0.541 秒，Loro 0.049 秒。
合计 SQLite 字节和整个进程 RSS 未下降。不能据此宣称网络往返加速或 Roost
独占内存变化。

Roost 已通过 Core SQLite 索引 15、Native 56、SDK Native 索引 37、进程索引
38、Chromium 63 项；完整串行 Rust 为 376 通过、6 忽略（含 4 doctest）。
默认并行仍间歇失败于既有 HTTP stub；隔离失败项与完整串行均通过，保留此
限制记录。Lody 四组专属套件 112 项通过。最终额外两个 focused 用例在 SDK
尚未采用缓存前丢失真实 Native 回复，并在已提交原子组后插入 peer goal 修改；
之后没有运行时代码变更。完整根检查/最终 docs gate 完成后在下文补充。

完整合成产物及源码哈希仅保留于仓库外现有 `atomic-derived-indexes` 研究目录，
包含每次原始轮次而非只有中位数。剩下的私有解码行复制、串行本地索引/事件
调用仍有成本；此 PR 没有删除这些检查，也不声称一次事务合并解决全部热点。


### 最终 gate 与新诊断

完整根 `pnpm check` 通过，包含类型/lint/Effect 检查、配置的各包测试及边界
检查；根 format 通过。把故障点下移到 SDK 确认之前后，Native 丢回复和 peer
goal 两个增强用例也通过。最终 docs 为 0 错误、71 既有警告，无无关源码改动。
Roost 配套 CI 的 linux-arm64 在编译前下载 pnpm 12.3.4 时 npm registry
30 秒超时，没有 TypeScript 编译诊断；已尝试重跑，但 GitHub 返回 HTTP 403：Windows job 所在工作流仍在运行，尚未排入
重跑。未宣称 Native 矩阵
CI 已全绿；此消费者保持草稿，待配套包发布/更新 pin 和 hosted 检查完成。

原子优化后新增主线程 V8 诊断：相同合成单回复 1000 × 1 KiB，关闭交错消费者
readChanges，保留完整正文/重试校验。它是本地 Mac 诊断，不是 Linux 对照。
采样区间 3.69 秒，1000 次追加。按互不重叠的 self 样本（非含子栈相加），
roost-content-patches.ts 13.72%、roost-node-session.ts 10.28%、GC 7.25%、
Node js_transferable 3.51%、idle 26.30%。最大的具名应用函数包括
stageRoostTextAppends 和 diff walk，证实增长正文的暂存/差异遍历/复制仍有成本；
不能把剩余全部差距或独立的新消息/分页成本归给它们。本 PR 不再据此继续修改。


消费者草稿：[Lody #1811](https://github.com/LodyAI/Lody/pull/1811)。Roost hosted
Rust 检查及 Native darwin-arm64/darwin-x64/linux-x64 已通过。剩余平台 gate 和
已发布配套依赖是明确的评审限制，没有修改任何生产会话或部署 staging。
