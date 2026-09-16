# 会话历史写入

Status: draft
Translation: current

[English](session-history-writes.md)

## 场景

同步来的会话包含未来版本的未知 item，或损坏的旧 text item。用户仍应能发送合法消息，
并流式修改另一项。但兼容旧数据不能变成允许本地创建格式错误的新 item。

## 契约

- 前端与 CLI 共用一个 HistoryWriter 进行本地历史修改。读取功能开关可切换视图，不能切换写入契约。
- 新轮次使用明确消息类型和运行时输入解析。原有带类型的 callback 调用通过会话适配层进入同一 writer。
- 一条命令修改历史前，先校验新增轮次和变化的已知字段/item。非法命令报告路径和错误码，
  保留旧值；另一条合法命令仍可执行。不重新校验无关旧 item。
- 闭合的新输入对象过滤未知字段，明确的协议扩展字典仍保存 JSON 数据。
  保留已存储的未知字段，以及未修改的未知/损坏 item；读取不意味着迁移或清理数据。
- 已有 primitive 字符串不升级容器；已有 Text 编辑保留容器身份。新写入把普通元数据字符串
  （工具的 `title`/`status`/`kind`/`toolCallId`、`locations[].path`）存为 primitive，
  只为真正流式增长的字段创建 Text 容器（`text`/`thought`、`markdown`、工具 block 的
  `text`/`output` 及嵌套 `content.text`、worktree step 的 `output`）。该规则对每个嵌套层级
  都成立：嵌套的工具/worktree 元数据如 `command`、`path`、`args`、`cwd`、`terminalId` 和
  `input` 值都是 primitive，绝不存为 Text。这是一条插入策略：不是迁移，不重写已存储的值，
  也不对旧数据或未来 payload 增加校验约束。存储布局变更单独审查。
- Fork 是复制已存历史，不是创建新消息。只能从 writer 捕获的快照复制，保留目标初始化日志，
  保留未改动的未知字段和不透明 item；显式修改及新增 fork notice 仍需解析。
  复制轮次插在目标已有轮次之前，拒绝 id 冲突，保留目标容器。
  调用者构造的 JSON 不能冒充这种来源。复制不修改源文档。
- 编辑后重发失败时，可恢复捕获的旧历史，不将其当新输入重验。一次性的本地回滚凭据
  只恢复本次变化的区间，保留未涉及轮次的当前内容及随后追加的轮次。期间若轮次身份/顺序变化，或区间内
  内容变化，则拒绝覆盖；区间内唯一例外是本次新插入的 pending 用户轮次
  变成 seen/read，且其他字段完全不变；它不是崩溃恢复或分布式事务。
  外部 provider 导入仍是新输入，不能借用已存历史复制权限。
- 这里的接受表示本地 CRDT 写入。持久化、权限和远端同步仍由原有 repo 和传输层负责。
- 除 type/toolCallId 外，工具字段只解析本次变化的值，不重验未修改的工具内容；
  只修改 outcome 时保留已有请求信息。修改工具身份需完整 item 解析；变化的 content block
  单独解析。新增字段非法时，整条命令在写入前拒绝。
- 新历史接受原有内置 CLI selector 的归一化，不重写旧历史。steer 配置和保持身份的
  task proposal 编辑也只校验变化的字段。
- 队列提升必须在历史接受后才删除队列行；写入失败保留队列行。
- 手动 Codex 压缩持有 native turn 直到完成。Stop 中断该 turn，并保留 ACP prompt，
  直到 `turn/completed` 确认结果或 provider 连接关闭。对已 in-flight 且 ACP session 就绪的
  prompt，Lody 记录取消并发送 provider cancel，不中断 owner fiber。ACP 返回前保留 owner
  和未完成的历史；新 dispatch 及未投递的 steer 保持 pending。raw steer 请求和在途 steer
  配置也纳入同一收尾流程。Stop 后五秒仍有请求未结束时，Lody 终止旧 session，让连接关闭
  结束请求。计时不等待 cancel ACK，
  也不因重复 Stop 重置。终止失败则继续持有 owner，直到 ACP 结束。start/interrupt ACK
  和压缩 item 的完成均不能释放执行 ownership。CLI 在取消确认后、接受下一轮前，
  将尚未结束的压缩标记为 failed。打开 Session 不触发历史修复 RPC，也不改写旧结果。
- steer adapter 只报告三种最终投递结果：`applied`、`not-applied` 或 `unknown`。只有
  `not-applied` 可以把同一个用户轮次交回普通 dispatch；`applied` 表示已经消费，
  `unknown` 则在历史中变为 `delivery_unknown` 并返回 `delivery-unknown`，绝不自动调度。
  显式重发必须提示原消息可能已经执行，并创建新的用户轮次；不能改写原投递结论。
  Session execution 不根据 Stop、传输失败或本地 ownership 状态推断投递结果。
- Stop 和目标 prompt 结束会中止本地文档加载、准备、配置及投递结论等待，释放 steer 队列
  和 rewrite lease；不取消原始请求，也不丢弃其结论。已经进入 applied 所有权交接的操作
  必须完整结束；排队中的 steer 不得为已停止的目标开始准备。结果持久化失败仍须释放
  application lease，并允许取消收尾继续。
- 执行端统一拥有 steer 状态，以及 `steerTurnStatuses` 中按消息 ID 记录的恢复激活。
  拒绝结果不得回退生产者的 `latestUserMsgId`，也不得清除其他消息的 missing-history 标记。
  watcher 在历史到达时投影结果，并在普通执行接管、终态投影或历史缺失失败后清理恢复项。
  RPC applied ACK 只是展示提示，不能由前端回写执行状态；迟到 ACK 不得复活终态消息。
  已应用的 steer provenance 必须阻止普通重启调度重放该消息。
- 取消 turn 必须显式携带 pending-input 策略。用户 Stop 可以提升已确定为
  `not-applied` 的 steer；Edit & Resend、访问撤销和 cleanup 必须保持它。若 Stop 先于
  `applied` 结果发生，晚到结果不能转移 ownership，也不能重放该用户轮次。重复取消竞争时，
  第一次写入的策略生效。
- pre-prompt ACP 生命周期独立于 pending input：Stop 选择 promote/discard，Edit & Resend
  选择 preserve/keep，访问撤销选择 preserve/discard。Edit & Resend 必须保留持有 prepared
  replacement 的进程。create/restore 原有的取消 fence 保持有效。
- promotion 写入失败不能丢失已确认的未投递结论。CLI 返回 `promotion-failed` 和错误，不能
  假装恢复成功或改报投递未知。daemon 的 `recoveryOwned` 响应表示恢复仍由该 daemon 负责：
  前端仅对明确的 promotion 失败通过同一 RPC 重试一次，持续失败则报错。旧响应保留
  pending_apply/pending/seen 的 dispatch 修复。不得复活 active、terminal 或已删除的轮次；
  超时或投递未知绝不授权重试。
- foreground run configuration 归属其 turn 的 Effect signal。turn 被中断后，在途配置请求
  可以结束，但不得再发送后续配置 mutation，也不得持久化被中断 turn 的 runtime patch。
  steer 配置使用目标的本地等待 signal，遵循同一 mutation fence。
- 已接受的 steer 标记在写入和读取归一化后都必须保留；编辑重发不能把 steer
  当作可独立重放的普通用户轮次。

## 外部导入的内容基线

来源 hash 和据此生成的 id 保持不变；文档 cursor 另存带版本的实际写入内容基线。
刷新时精确比较已有 role/items/plan，不把旧内容裁剪后再比较。没有基线时仍严格比较
旧来源 hash；用户删除旧轮次应视作冲突，而不是自动恢复。基线只绑定同一 cursor 的
来源 hashes，不采用可能已提前更新的元数据 digest。hash 版本出现之前写入的基线没有
版本字段，视为 v1，可与 v1 cursor 匹配；把缺失字段当作“不是 v1”会丢弃合法的投影基线，
把正常追加误报为冲突；真正的 v1/v2 不一致仍被拒绝。显式解决冲突后记录新基线。

规范轮次 hash 带版本。v1 原样哈希 `{role, items, plan}`；v2 哈希规范化的 item 形式，
使被封存的 tool_call 骨架与封存它的完整 tool_call 得到相同 hash，且只改变工具 payload
字节的来源变更不改变轮次身份。缺失版本即为 v1。每个 hash 只与同版本的 hash 比较；
存储的 cursor 记录自己 `importedTurnHashes` 的版本，同步元数据独立记录自己
`replayDigest` 的版本，因为冲突标记可能只更新元数据。v1 文档 cursor 绝不能按 v2 解读，
否则会制造假的 `prefix_mismatch`。版本不一致且缺少可用于重算的 replay 历史时是错误，
而不是宽容猜测。新导入使用 v2；现有 v1 规范化规则不变。

这会新增可选 cursor 元数据，但不迁移历史正文。旧读取端可忽略新字段；旧导入器
不理解基线，仍可能对已裁剪的历史报告冲突，因此不是任意降级安全保证。

## 边界与待审事项

这不是任意跨版本兼容或 reader 安全的证明。TypeScript 无法保证不可信输入、字符串语义约束，
也不能阻止刻意的类型断言/底层访问。修改已损坏 item 的命令可能需要修复该 item，
不能借用针对“未修改历史”的兼容处理。初版 callback 适配支持保持既有轮次顺序的修改，
不支持任意重排普通 LoroList 中的已有轮次。

目前完整 Mirror 读取仍会物化历史，本次不是 3000 轮性能验收或窗口化 ConversationView 上线。
非历史控制字段的校验不属于这个 HistoryWriter 契约。v2 规范形式只针对本仓库当前写入的
形状定义。完整的封存骨架特性（读取侧的 `ref` payload 拉取、payload hook 以及消费它们的
UI）不在本次实现；本次只是保证将来出现这类骨架轮次时不会被误判为 hash 冲突。

## 实现证据

- `packages/shared/src/{history-writer,history-write-schema,history-materializer,session-mirror,schema}.ts`
- `packages/shared/src/session-data/{history-import,loro}.ts`
- `apps/cli/src/lib/local-project-history-sync-service.ts`
- `packages/shared/tests/history-writer.test.ts`、`history-writer.contract.ts`、
  `history-storage-policy.test.ts` 与 `session-history-import-port.test.ts`
- `apps/cli/tests/local-project-history-sync-service.test.ts` 与 `local-project-history-sync-writer.test.ts`
- [决策记录](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.zh.md)
- [业务字段修复与待定 hash 决策](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.zh.md)
- [外部历史基线修复](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.zh.md)
- [中断时 pending input 的 exactly-once](../.agents/notes/implemented/bug-fix/2026-09-14-interrupt-pending-input-exactly-once.zh.md)
- [Steer Stop 与恢复所有权](../.agents/notes/implemented/bug-fix/2026-09-16-steer-stop-recovery-ownership.zh.md)
- [带版本轮次 hash 与 primitive 元数据插入](../.agents/notes/implemented/architecture/2026-09-14-versioned-history-hashes-and-primitive-metadata.zh.md)

这是供人工审阅的草稿；实现和测试通过不代表 Spec 已获批准。
