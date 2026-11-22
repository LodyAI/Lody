# Automation 账本查询列与截止时间调度

Date: 2026-11-21
Status: implemented
Translation: current

[English](2026-11-21-automation-ledger-query-columns.md)

## 摘要

Automation 账本此前把几乎所有可查询字段都塞进 JSON `payload` 列，热谓词全部
通过 `json_extract`/`json_each` 做全表扫描，并在主线程上同步解析 JSON；provider
容量事件还会因为上一次快照过期或 fingerprint 不匹配而反复发布恢复事件，把事件
表灌水。Schema v4 把所有谓词字段提升为带索引的真实列，payload 仅保留为接受时
冻结的记录，wait 的资源读取也移入 `wait_reads` 关联表。引擎循环改为在显式唤醒
信号与"睡到最早 durable 截止时间"之间竞速，上限 15 秒，取代"还有活就重扫"和
每秒探测。容量事件只在确认"不可用→可用"转换时发布，而恢复唤醒扫描仍跟随每次
新的匹配可用观察，但通过规范化列把候选收敛到本次观察的 binding/model，不再做
全工作区的 payload 扫描。

## 决策与归属

每个谓词字段都是带索引的真实列，索引覆盖其访问路径；`payload` 只在重建领域
对象时读写。`waits.due_at` 在写入时计算 `min(nextCheckAt, expiresAt)`，`dueWaits`
因此是单索引范围扫描。`receipts.session_id` 取代了原来对 `sessionId`、
`target.sessionId`、`parameters.sessionId` 的三路 OR——接受路径保证三者一致。
`retry_at` 用 `0` 表示"立即到期"的行——新收据与已暂存的 turn 结果——而认领
提交写入 `now + 15s`：在途提交绝不能把账本下一个截止时间钉在 0，提交中途
崩溃也仍在与其他重试相同的 15 秒界内完成对账。迁移是幂等的——每个 `ALTER` 都由
`table_info` 检查保护，已部分列化的数据库也能干净升级——并通过与写入路径共用
的 `columnsFrom*` 辅助函数重新解析 payload 回填，消除了 SQL `json_extract`
回填会引入的 SQL/JS 漂移。回填读取以 512 行为一批、按 rowid 键推进：整表
`.all()` 会把全部 payload 列物化进内存，而流式 `.iterate()` 无法与同一事务
内的写游标共享连接。

可选谓词绝不编译成 `(? IS NULL OR col=?)`：SQLite 会因此放弃整条语句的索引，
所以 `wantsRead`、`waits`、`activityPage` 改为按参数形态生成专门语句。驱动型
查询保持共享非终结集上的正 `state IN` 列表——`NOT IN` 曾让 SQLite 完全弃用
截止索引——`receipts_due_active` 是该列表上的部分索引，`pending` 与
`nextDueAt` 因此只检索存活行。

需求读取者拿工作区级集合，绝不做逐会话查询。PR poller 此前在 `buildTargets`
里对每个被跟踪会话各调一次 `wantsRead(resource, sessionId)`——真实工作区每趟
约 460 次同步读，而每次 wake 又会跑两三趟。`wantsReadSessions(resource)` 用一条
走索引的 join 返回等价的 `Set`；`buildTargets` 与工作流记录循环只做
`Set.has` 成员检查，需求成本不再随会话数增长。

持久拒绝要收敛，而不是无限期重验。`admit` 在派发时复查每条排队输入：携带
`terminalState` 的 `no`、`guard:` 判定、或命中持久集合的 reason（被撤销的
grant/授权、已删除目标、已终结或不匹配的 pending work）会把收据推入
`cancelling`，由引擎的取消路径移除队列行并终结它。行仍存活的 queued 收据在
重新发信号前会在 `reconcile` 里做同一检查。停止与归档目标保持瞬态——两者
都可由用户恢复——按设计维持重试的 `queued`/`blocked`。被替代的等价方案是
"准入被拒"的布尔值配定时器重试，正是它在死输入上制造了大量
`automation-admission-blocked` 噪音。

guard 判定在所有评估点共用一个 `guard:` reason 命名空间——引擎的 `check()`
与资源准入的 `recheck()` 都给 guard 否定加前缀，`isDurableSessionDenial`
因此对两者分类一致。缺少统一命名空间时，admission 处返回的原始
`delivery_pr_changed`/`delivery_step_replaced` 会逃出持久集合，已过期的输入
无限重验——这正是该命名空间要关闭的已确认评审缺陷。取消保留原始拒绝原因：
`guard:` 收据以 `superseded` 终结，其余持久拒绝以 `cancelled` 终结，reason
均为原始值而非 `user_cancelled`。

`nextDueAt()` 报告未终结 waits、未终结 receipts 与已暂存 turn 观察中的最早
到期时间，存在已接受 delivery 时立即到期。每轮循环睡到 `min(nextDueAt, now+15s)`
或等到唤醒信号；15 秒上限保证 `host.observe`——暂存结果对账与自动投递推进——
在没有账本截止时间时仍能推进。暂存行在属主读取前先顺延 15 秒，所以
`retry_at = 0` 只出现在暂存与下一轮 pass 之间，正是需要立即 pass 的时刻。

`provider.capacity.available` 只在上一次同 fingerprint 观察评估为 `no`、本次为
`yes` 时发布。恢复唤醒扫描不受事件门控：每次新的匹配 `yes` 都会把
`capacityWakeRevision` 按推送一次（而非按子观察）递增，因为停在
`MAX_SAFE_INTEGER` 的收据没有其他复活通道，且 `unknown`→`yes` 仍构成新证据。
扫描范围限定到观察的 binding/model——`receipts.work_id` 连接 `work` 表的
`binding_id`/`fingerprint`/`model_id` 列——成本只随匹配候选集增长，不随
工作区恢复收据总数增长。`capacity` 表中的 marker 行记录每个 binding/model
键已扫描的最高 `observedAt`；相同或更旧 `observedAt` 的重推快照不会产生新
唤醒，直接跳过扫描。

## 被拒绝的替代方案

- 基于 `json_extract` 的表达式索引：谓词文本必须与索引表达式逐字一致，
  `json_each` 横向连接根本无法建索引，且存储依旧非规范化。`operation-store.ts`
  是"真实列 + payload 记录"范式在本仓库的先例。
- SQLite worker 线程：同步 better-sqlite3 并非缺陷根源——schema 才是——把账本
  移出主线程还会迫使同步的 admission 回调（`canSubmit`、`setPendingWork`）异步化。
- 事件保留期/删除：推迟。删除事件行后同源同 id 事件会重新发布并撞上当前用于
  去重的 deliveries 主键；安全的保留期需要单独的 `event_keys` 表。
- 对原始诊断的一处更正：schedule 的 `isFinished` 通过 `hasAutomationSessionWork`
  读取内存快照；此前归咎于它的账本扫描实际发生在 admission 路径上的
  `SessionAutomationAuthority.inspect()` 中。

## 验证与限制

测试覆盖：v2→v4 迁移（含部分列化数据库与暂存结果保留）、针对查询白名单的
`EXPLAIN QUERY PLAN` 棘轮（热表上的任何 `SCAN` 都失败，含覆盖索引扫描；小的
rule/source 表扫描放行）、每条写入路径后的列↔payload 一致性、容量发布门控与
唤醒解耦、fake timers 下的截止时间/唤醒/15 秒上限调度、每次 build 的工作流
需求读数有界（与会话数无关）的调度回归，以及跨队列边界的收敛：准入 guard
过期的排队 continuation 被真实的 `cancelInput` 移除并以 `superseded` 及原始
guard reason 终结，而停止的目标继续等待。在推迟的保留期设计落地前，事件表
增长仍仅由源头纪律约束；持久拒绝集合人工维护在产生这些 reason 的授权器旁。
