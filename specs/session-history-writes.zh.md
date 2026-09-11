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
- 已有 primitive 字符串不升级容器；已有 Text 编辑保留容器身份。存储布局变更单独审查。
- Fork 是复制已存历史，不是创建新消息。只能从 writer 捕获的快照复制，保留目标初始化日志，
  保留未改动的未知字段和不透明 item；显式修改及新增 fork notice 仍需解析。
  复制轮次插在目标已有轮次之前，拒绝 id 冲突，保留目标容器。
  调用者构造的 JSON 不能冒充这种来源。复制不修改源文档。
- 编辑后重发失败时，可恢复捕获的旧历史，不将其当新输入重验。一次性的本地回滚凭据
  只恢复本次变化的区间，保留未涉及轮次的当前内容。期间若轮次身份/顺序变化，或区间内
  内容变化，则拒绝覆盖；区间内唯一例外是本次新插入的 pending 用户轮次
  变成 seen/read，且其他字段完全不变；它不是崩溃恢复或分布式事务。
  外部 provider 导入仍是新输入，不能借用已存历史复制权限。
- 这里的接受表示本地 CRDT 写入。持久化、权限和远端同步仍由原有 repo 和传输层负责。
- 工具状态、权限请求与描述元数据（title/kind/locations）只解析本次变化的字段，
  不重验未修改的工具内容；只修改 outcome 时保留已有请求信息。
  修改工具身份或内容仍需完整 item 解析；新增元数据非法时，整条命令在写入前拒绝。
- 已 finished 的 assistant turn 可能包含未持久化 provider 终态的旧 context-compaction
  activity。打开该 Session 时可以请求修复，但只有 owner daemon 能修改指定 turn 和 tool
  item，且必须先由实时执行所有权证明该 turn 已不活跃。Turn `finished`、持久化 Session
  status、经过时间、daemon 重启或缺少 live evidence 均不充分。Daemon 离线、不支持该能力、
  不持有 Session 或无法确定时，历史保持不变。Repair 必须读取已完成远端同步的 Session
  document；rewrite barrier 仅覆盖最终 live-state 检查和本地修改，释放后必须同时唤醒普通
  turn 与 Goal turn dispatch；只有写入确认后才能返回 `reconciled`。非终态结果可在后续
  history、连接或 daemon generation 证据变化时重试。
- 已接受的 steer 标记在写入和读取归一化后都必须保留；编辑重发不能把 steer
  当作可独立重放的普通用户轮次。

## 外部导入的内容基线

来源 hash 和据此生成的 id 保持不变；文档 cursor 另存带版本的实际写入内容基线。
刷新时精确比较已有 role/items/plan，不把旧内容裁剪后再比较。没有基线时仍严格比较
旧来源 hash；用户删除旧轮次应视作冲突，而不是自动恢复。基线只绑定同一 cursor 的
来源 hashes，不采用可能已提前更新的元数据 digest。显式解决冲突后记录新基线。

这会新增可选 cursor 元数据，但不迁移历史正文。旧读取端可忽略新字段；旧导入器
不理解基线，仍可能对已裁剪的历史报告冲突，因此不是任意降级安全保证。

## 边界与待审事项

这不是任意跨版本兼容或 reader 安全的证明。TypeScript 无法保证不可信输入、字符串语义约束，
也不能阻止刻意的类型断言/底层访问。修改已损坏 item 的命令可能需要修复该 item，
不能借用针对“未修改历史”的兼容处理。初版 callback 适配支持保持既有轮次顺序的修改，
不支持任意重排普通 LoroList 中的已有轮次。

目前完整 Mirror 读取仍会物化历史，本次不是 3000 轮性能验收或窗口化 ConversationView 上线。
非历史控制字段的校验不属于这个 HistoryWriter 契约。

## 实现证据

- `packages/shared/src/{history-writer,history-write-schema,session-mirror}.ts`
- `packages/shared/tests/history-writer.test.ts` 与 `history-writer.contract.ts`
- `apps/cli/src/lib/assistant-turn-finalize.ts` 与经过 capability gate 的
  `session/reconcile-context-compaction` Machine RPC
- [决策记录](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.zh.md)
- [旧 compaction 修复决策](../.agents/notes/implemented/bug-fix/2026-09-11-stale-context-compaction-reconciliation.zh.md)
- [业务字段修复与待定 hash 决策](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.zh.md)
- [外部历史基线修复](../.agents/notes/implemented/architecture/2026-09-07-single-history-writer.zh.md)

这是供人工审阅的草稿；实现和测试通过不代表 Spec 已获批准。
