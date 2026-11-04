# Roost 控制通知开销

Status: proposed
Type: architecture
Translation: current
Owner: Codex
Updated: 2026-10-23

[English](2026-10-23-roost-control-storage.md)

## 摘要

本轮只保留删除未被读取的控制通知 operationId：Native 幂等收据及操作身份完全保留，cursor/revision/count/change 的原有表示、发布顺序、每动作持久化与恢复路径不变。新的紧凑二进制进度编码、缓存及其前端适配已撤回；没有新控制格式、兼容读取器或迁移。Native 页尺寸、行布局和热索引块打包的实验均未采纳，Rust 源码已与实验前 31 个文件哈希逐一比对恢复。固定负载资源和正确性测量已完成，速度不退步条件尚未通过；没有发包、部署或清理任何真实数据。

## 原因与边界

控制文档当前值约 246 B，但千条会话保存了 12,001 条更新、38,504 个 CRDT 操作；这是逐次发布的控制历史，不是又一份消息正文。完整消息正文已经由共享帧表示，不能重复声称“去掉完整正文复制”作为本轮新收益。直接裁掉控制 CRDT 旧操作会破坏离线版本向量同步，不在本轮范围。

源码核对发现 control operationId 只有初始化时原样携带，没有读取者；幂等/身份冲突/丢回复恢复使用 Native 的操作收据及摘要。本轮不更改这些凭据，也不改 withWrites 的操作身份、owner、提交序列或失败恢复。只删通知对象的未读副本与两个类型/schema 声明，保留原订阅和发布屏障。既有 renderer 不需要新协议，通用 Loro 和纯 Loro 会话路径不变。

## 选择与被撤回的实验

曾试过把完整进度编码为单个 primitive，压缩 u64、计数及变更提示；跨 peer、非法格式、Unicode/孤立 UTF-16 和重开测试通过，但整库收益只有约 5%，速度没有明确改善。随后做 operationId-only 最小对照：如果收益接近，应保留小改动，撤掉协议与编码复杂度。相关代码和原始结果均留在独立实验工件中，不进入候选。Native 的细节、失败结果及已存在的 KV 压缩事实由 Roost 的 `.agents/notes/proposed/architecture/2026-10-23-storage-amplification.md` 记录，本文件不复制其决策日志。

## 验证流程与进度

使用 [固定验证流程](../../../docs/roost-validation.md)。实验根目录：`/Users/lampese/Code/roost-lody-pr-integration-20261022/shared-body-validation/`，最终最小候选为 `storage-amplification-id-only/`。Native 和 SDK 使用同一解析绝对路径、同一二进制/SDK 内容；运行时源码覆盖有 finally 恢复和独立锁。每个新动作仍 SQLite WAL/FULL 并完成持久化；所有负载完全合成。

- 最小候选 CLI owning 121 项通过，重试测试还验证控制字段未写入、原有进度有效、相同身份只追加一次且身份冲突拒绝。
- 当前 benchmark 四负载、重开/唯一分页和 100/1000/10000 前缀；短负载和 1 MiB reply 追加配对样本以观察宿主负载噪声。原始失败和回归不隐藏。
- Loro 的 103 个原始包文件和三个固定 harness 哈希每阶段校验。最终会补同时段原 Loro 对照，不拿不同实现或不同数据量算倍率。
- 不把配置外 tsc 或 Native release fixture 的工具链失败称为配置检查；使用 owning 类型/行为命令。最终 CLI/shared/components 配置类型检查及 Native 38 项通过；docs check 的 Abstract 标题错误已修正，终检通过（72 个 warning，含新 Note 的待翻译项；无错误/受保护 topic 待确认）。Oxfmt changed-scope check 通过。未运行根级全量 check/format，候选未提交。

## 后续设计

既有 readChanges/watchChanges 已能提供权威的 Native 增量，控制文档仍被用作 publishedNativeCursor 的持久化发布屏障及其他 owner 的唤醒来源。不能直接删 cursor 或停止通知：那会使检查点失败或让客户端等待超时。若要进一步去掉每片段的 CRDT 历史，需要先把完整发布屏障原子地落在 Native，并证明跨 owner 唤醒、首次连接/重连、丢回复、取消及 revision/count 一致性，再让前端依赖已有 watchChanges。它不是删几行订阅；该设计随后在 [Native 发布边界](2026-10-23-roost-native-publication-boundary.zh.md) 中实现并单独测量；本研究不冒充后续重构的验收。Native 的冷热分离同样只是未实施方案，seal 阶段成本尚未验收。

## Effect 与生命周期

feature/fix 模式，保持锁定 Effect 4.0.2。本轮是删除未读字段，不产生新的资源所有者、异步生命周期或依赖链，因此不扩大为 Effect 迁移。写入序列、取消、提交后通知、回滚与恢复都沿用原路径。

## 最终候选数据与停止条件

147 个阶段全部通过：四负载写入/重开/唯一分页，100/1000/10000 前缀，短/reply 每侧六轮及其他负载每侧两轮，同时段原 Loro 每负载两轮。每阶段有 SQLite quick/FK；完整重开摘要、跨后端业务摘要一致。新 codec 已删除，Native 31 个源码文件与基线、两侧 Native 二进制 56b737... 完全一致，103 个 Loro 包文件哈希未变，原依赖链接已恢复。新增运行时改动只在 roost-node-session.ts 和 shared/schema.ts；本轮不含此前未提交的追加 CPU 优化。

| 负载          | n（每侧） | DB 增量 KiB 前→候选 | Loro KiB | 追加 CPU 秒 前→候选 | 追加 p95 ms 前→候选 | RSS MiB 前→候选 | RSS 增长 MiB 前→候选 |
| ------------- | --------: | ------------------: | -------: | ------------------: | ------------------: | --------------: | -------------------: |
| 短会话        |         6 |             240→216 |      128 |         0.312→0.317 |         1.374→1.579 |     389.6→386.4 |          +62.2→+59.3 |
| 千条/万次追加 |         2 |       24,200→23,314 |   13,720 |        12.273→7.808 |         2.364→1.042 |     545.0→543.8 |        +216.7→+215.8 |
| 1MiB 回复     |         6 |         1,804→1,716 |    1,448 |         0.897→0.957 |         0.990→1.085 |     473.4→473.6 |        +145.8→+146.0 |
| 混合/继续     |         2 |         3,300→3,200 |    1,904 |         1.466→1.413 |         2.133→2.078 |     516.8→515.9 |        +189.8→+188.9 |

都是独立 Vitest 进程，RSS 含框架，不是线上 CLI 测量；增长从 backend-open 到完整验证前。逻辑 DB 页增量排除 WAL/SHM。追加 CPU 包含每动作持久化，排除创建、finish、分页与导出。Native 历史库页数因新签名/键值等自然变化略有差异；确定的写入差别在控制通知。旧库已保留的 CRDT 历史不会自动变小。

不能把千条 CPU 的下降宣称为确定加速：基线两轮 8.833–15.713 秒，候选 7.442–8.173 秒，宿主曾有其他约四核 Node 工作。1MiB 六轮 CPU 候选中位数约高 6.7%，p95 高约 0.095ms；原因尚未隔离，不满足“不牺牲速度”的验收条件。10,000 前缀两轮也有不利结果：打开 300.5→333.7ms、首选择 2.61→3.90ms、温追加 1.30→2.59ms、冷首追加 76.2→87.1ms、验证前 RSS 423.2→425.1MiB。不能用规模小/绝对毫秒小来替用户批准这些差异。

因此当前为**未完成性能验收的本地候选**，不是推荐合并结果。未创建/更新 PR，未提交、发包或部署。按用户“保证不了马上停下来继续请示”的要求，停止继续扩大实现，需讨论下一步是隔离速度差异、允许具体差异，或先评审 Native 发布屏障重构。不能宣称体积主问题已解决；千条候选仍是同时段 Loro 的约 1.70 倍。

完整数据：实验目录 `report.zh.md`、`resource-summary.json`（样本、范围、类别、RSS 轨迹/增长）、`prefix-summary.json`、`environment.json`、`benchmark-status.json`、`postconditions.json` 和本轮相对初始源码的 `this-task-runtime.patch`。Loro 的 HTTP/Stream offset 未在本轮测量。所有未采纳实验仍可复查，后续工作应从这些证据继续，不再从零做同一物理布局或重复添加单值压缩。
