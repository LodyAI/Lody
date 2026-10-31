# Roost 与 Loro 的历史目标访问

Status: proposed
Type: architecture
Translation: current

[English](2026-10-31-roost-selective-history-reads.md)

## 摘要

权限、输出和配置查询此前通过完整历史数组定位少量字段，结构写入的后备路径也会复制未变正文。实现将元数据选择与正文展开分开，Loro 使用局部写入，Roost 通过 SDK 成员操作复用物理 Turn。本记录说明涉及的路径、存储选择和内存测量。

## 读取范围

Fork 快照、导入／冲突规划、导出、分享、复制及 CLI `history --all` 消费选定的完整内容。普通查询通过元数据定位记录，再展开结果集。计数、不存在检查和多归属选择可能遍历全部相关字段。

恢复重放逐条访问源正文。格式化器保留按预算限制的 A/B/C/D 候选、消息总数和有序工具路径集合；默认 prompt 预算为 100,000 字符。

## 涉及路径

Loro 列标明纳入范围的九项完整正文读取；其输出、目录和最近目标读取此前已有浅选择。

| 编号 | 选择与更新依据 | Loro | Lody PR |
| --- | --- | --- | --- |
| 1 输入 gate、prepared／预分配输入 | gate 检查任意匹配 user；幂等比较首个匹配的存储记录 | 是 | #2132 |
| 2 CLI 配额、活跃回复、配置、MCP 和有限历史 | 计数／状态／配置字段；有限 transcript 按可见位置选择和展开 | 是 | #2132 |
| 3 用户归属、usage 和目标预检查 | 权限使用最近非空白 user 作者；usage 使用独立的不限定 role 谓词；目标走最近目标读取 | 是 | #2132 |
| 4 权限插入、答复和等待 | 按 tool／request 选择归属；插入处理全部匹配工具，默认答复选首个 assistant owner，等待选首个匹配工具 | 是 | #2132 查询，#2133 Loro 写入 |
| 5 回合输出 | user 标量、后续首个关联 assistant，以及 user 失败后的 system 条目 | 已有浅查 | #2132 |
| 6 目录、role 和 dispatch 索引恢复 | primary／late／state 逻辑字段与成员引用 | 已有浅查 | #2132 |
| 7 未知投影下的目标定位 | 最近有效目标字段，包含 cleared／paused 状态 | 已有浅查 | #2132 |
| 8 定时提案和运行列表 | 输入配置、scheduleRun 和最后一个关联非 user 回复状态 | 是 | #2132 |
| 9 历史 action | goal／tool／file 归属、notice 精确匹配及插删位置 | 是 | #2132 选择器，#2133 Loro 写入 |
| 10 worktree 输出和 Agent 批次 | 目标 ID、tool／task 归属、递归 subagent 祖先和实际 assistant 尾部 | 是 | #2132 Roost，#2133 Loro |
| 11 编辑／重发和补偿 | 最近 user、provider 边界、配置与目标；选中后缀及变更范围回执 | 是 | #2132 预检查／Roost，#2133 Loro 写入 |
| 12 复制目标检查和诊断 | 已有 ID、条目类型计数、有界异常键样本及末条统计 | 是 | #2132 |

## 查询设计

共用元数据读取提供身份、状态、用户归属、定时标记和白名单输入配置。Loro 直接读取存储容器，包含旧文本字段和冻结的 Role 展示快照；无覆盖参数的续聊在目录中的 Role 修改或删除后仍保留该快照。Roost 合并 primary、late、完整 state、delta state 和权限答复段，形成逻辑投影。

渲染端元数据读取复用通过现有有效性检查的完整 IndexedDB 快照。单次只读事务通过游标逐条投影缓存消息，补齐旧目录行缺少的元数据；缓存不完整或已失效时继续请求 owner。

Native owner 队列将选择和展开绑定到一次 generation／事件观察。dispatch 索引恢复读取字段页；初始 Create 摘要恢复在 Native 内逐条扫描不可变创建字节。

Owner RPC 协商 `sessionHistoryInspection` v2。元数据、最新 goal、限定条数的转录和 replay 查询在 owner 命令队列内执行，结果与对应的发布版本一同返回。replay 返回预算内提示词及统计；ID 查询使用已有的单条请求。

后端开始释放时，replay 和通用 fold 在当前正文读取结束后的读取边界停止，以失败结束这次查询。owner 队列继续完成已接受的写入，再释放存储租约。

通用选择先返回查询字段的摘要，再在一个 owner 任务内核对这些字段并展开目标位置的正文。普通文本编辑不会使未变的选择失效。不支持 v2 的 owner 保留优化前单次 `readAll` 的兼容路径；已声明支持 v2 的接口发生错误时，错误直接传递，不切换路径。既有 v1 请求继续接受。

## 写入设计

Loro 的 `HistoryWriter.updateSelected` 展开选中位置后调用现有 reducer；元数据占位记录省略了存储扩展字段，因此规划阶段拒绝修改这些记录。范围补偿保存变更前像，检查完整浅成员信息和本次操作回执；写前 ID 集合用于识别新插入记录允许的自动 seen/read 变化。

补偿只在已验证的范围内用完整前像进行写入对齐。区间内未变记录以及前后缀保留原容器身份，迟到的同步编辑仍合入原记录。后来追加的同 ID 记录不参与恢复对齐。

Roost 结构编辑使用 SDK 成员 manifest 引用已有物理段，重新插入的业务 ID 使用新物理 primary 别名。有界私有准备生成封存根，最终激活同事务提交根引用、分支 revision 和回执。立即补偿恢复旧 head，已有后续追加时通过另一次目标成员修改完成补偿。

重放和诊断使用同一查询／owner 接口；新 Fork metadata 发布期间，worktree 记录沿用已绑定后端。

相关决策见 [dispatch 标量投影](2026-10-22-roost-dispatch-scalar-projection.md)、[增量变更](2026-10-22-roost-end-to-end-incremental-mutations.md)和 [GC 目标查询](../../implemented/architecture/2026-10-30-application-memory-attribution.md)。

## 内存测量

两组按顺序启动的新进程配对使用 128 × 1 MiB 合成历史正文和很小的当前回合。Lody 基线为 `6f29141a6`，实测候选为 `fd941274f`；两边共用 Roost 源码 `ad6dab8`、Node 24.22.1，以及 macOS arm64 上 Rust 1.98.1 的优化 Native 构建。Native SHA-256：`b07cc8209ef4eff6ee7e6da91ae49e3d26bbc791f3c6475795060952aca278f0`。

测量准备后的首次请求、GC 后保留堆、footprint 及进程峰值 RSS；每个样本检查实际权限持久化／答复或输出 ID。

| 指标 | 权限修复前 → 后 | 单回合输出修复前 → 后 |
| --- | --- | --- |
| 额外保留 JS 堆 | 125.77 → 0.51 MiB | 125.97–127.79 → 0.041 MiB |
| 额外 footprint | 64.30–108.13 → 1.17–1.27 MiB | 35.93–56.91 → −0.91–0.13 MiB |
| 含准备过程的进程峰值 RSS | 1552.30–1557.83 → 677.98–702.78 MiB | 986.59–1006.34 → 525.17–525.69 MiB |
| 首次请求耗时 | 15856–15990 → 22.45–22.92 ms | 7956–7961 → 10.30–10.50 ms |
| readActiveBranch／readAll／readHistory | 2／3／1 → 0／0／0 | 1／0／0 → 0／0／0 |

这些是合成场景的单进程数据。峰值 RSS 包含准备和 Native 临时分配，footprint 包含 GC／内存页波动；权限与输出此前填充同一缓存，收益存在重叠。

## Owner 查询的字段复用（2026-11-01）

共用 inspection 入口此前先准备完整字段索引，再选择查询类型。认证过的 goal 摘要和按顺序进行的 replay 不需要这些字段；它们现在直接使用同一会话的 owner 队列和稳定 Native 观察。缺少 goal 摘要时继续做权威发现。replay 与通用 fold 按逻辑成员顺序逐条展开正文，沿用原有格式、预算、路径及统计。

转录查询在私有索引中缓存条目类型、文本非空标记和图片数量。每个被写入的记录都会失效，包括其他元数据完全相同的纯文本变化。索引 token、缓存代次和精确事件覆盖用于区分当前条目与旧版本 owner 的写入。缓存缺失、损坏或不可用时，继续使用原字段投影。缓存不保存文本，返回结构保持原样。

稀疏成员规划已经持有认证过的字段投影。未变物理成员复用这些字段，替换成员使用完整准备值和新的物理别名。复用要求连续的 Native 独占本地写入区间、匹配的激活 revision／head 和观察 scope，以及最终 generation／cursor 校验。索引在结构操作中重写，后续查询直接使用；重写被打断或期间出现外部变化时，重新读取权威字段。正常追加和流式写入增量维护索引，重新打开会话时复用有效的持久化检查点。没有有效投影时，依赖索引的查询分页遍历全历史所需字段，完成索引重建和持久化；重建失败时该次查询失败。

SDK 分页解码器另行复用同一 Turn 已取得的权威头，省去只为取得不可变父边而再次导出完整 Create 的步骤。正文／头部比较、稳定读取和有界封存正文缓存沿用原实现。这是 TypeScript SDK 内部修改，Native API 和存储格式没有变化。

基线为 Lody `29d74d496` 和已发布 SDK／Native 0.3.1。测量使用 Node 24.22.1、32 GiB 内存的 Apple M4 和真实临时 SQLite 数据库。主要样本为 8,192 条合成记录，每条约 1 KiB 文本，另有运行中的 assistant。建库、完整参考读取和建连不计入耗时，SDK／系统缓存已热身；用未就绪的 inspection 标记触发字段发现。在查询第一次 Native 请求处，以显式信号提交输出和权限写入；所有查询和持久化结果均与完整参考比较。耗时是观测值，本组实验不测量应用 RSS。

| 操作 | 修复前 | 本次实现 |
| --- | --- | --- |
| 输出变化后重复查询最后 50 条 | 3.44 秒 | 0.31 秒 |
| 字段索引未就绪、已有认证摘要的 goal 查询 | 4.09 秒 | 2.06 毫秒 |
| 字段索引未就绪时的 replay | 8.49 秒 | 4.57 秒 |
| 删除一条记录后的元数据查询 | 4.08 秒 | 0.25 秒 |
| 删除操作加随后的元数据查询 | 约 5.6 秒 | 2.32 秒 |
| 127 × 1 MiB 前缀加少量运行中尾记录的 replay | 7.81 秒 | SDK 复用头部后为 2.42 秒 |

删除本身从约 1.5 秒增至 2.06 秒：其中 0.44 秒的索引重写替代了后续字段重新发现，组合耗时下降。真正没有就绪字段索引的元数据查询仍需约 4–5 秒，首次转录可见性也需要计算。输出排队时间随前置查询耗时变化；权限写入有相同排队关系，其自身也可能需要冷索引。replay 用于 Agent 恢复，限定历史也可在输出期间调用。

范围分页把条数变化归为 stale，使用既有有限重试。编辑重发在构造替换输入前规范化继承配置；选择期间输入变化时，先关闭已准备的 ACP 会话，再返回 `STALE_USER_TURN`。共用服务同时用于 Loro 和 Roost。

## 验证

[Native 合同套件](../../../../apps/cli/tests/roost-session-backend-contract.test.ts)覆盖冷恢复、目标读取、回执恢复、分支变化、可见性失效、旧版本写入，以及稀疏修改和强制字段重建后的状态覆盖；[RPC 测试](../../../../apps/cli/src/session/roost-session-backend.test.ts)覆盖检查点／generation 变化。[Writer 测试](../../../../packages/shared/tests/history-writer.test.ts)与 [Agent 存储测试](../../../../apps/cli/tests/session-history-storage.test.ts)比较持久化结果和范围补偿；[重放测试](../../../../apps/cli/src/lib/replay-prompt-builder.test.ts)精确比较不同预算下的 prompt 与统计。

Electron 验收覆盖两后端的续聊、Fork、目标、队列和未读状态。依赖验证使用已发布的 `@loro-dev/roost@0.3.1` 和 `@loro-dev/roost-node@0.3.1`。

## 依赖

[Roost #29](https://github.com/loro-dev/roost/pull/29)提供 SDK／Native 接口；[基础 #2132](https://github.com/LodyAI/Lody/pull/2132)包含共用查询与 Roost 接入，[Loro #2133](https://github.com/LodyAI/Lody/pull/2133)在其上补充目标写入。Lody 通过 SDK 与 Native 0.3.1 使用上述接口，锁文件包含全部六个精确版本的平台包。

[编辑重发测试](../../../../apps/cli/src/session/session-edit-and-resend-service.test.ts)覆盖继承配置、并发选择拒绝，以及释放编辑屏障前关闭已准备的会话。
