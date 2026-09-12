# session-data 的存储自持快照服务

Status: implemented
Translation: current

[English](2026-09-12-storage-owned-snapshot-service.md)

## 摘要

PR #376 的存储拷贝能力从「经 CLI 门面传递的模块级句柄」改为存储自持的端口服务。
`SessionData.snapshots` 签发不透明、带品牌标记的 `SessionSnapshot` 句柄，并绑定到签发
存储的身份与 `sessionId`；调用方只传选择集与句柄，`release` 幂等地使其失效，伪造/异库
句柄抛 `invalid_snapshot`/`cross_store`，源存储关闭后所有存量句柄一律报
`source_closed`。`snapshot.read()` 是句柄自带的完整、分离式存储读取，`copyFrom` 接受同
后端跨存储句柄，因此真实的 fork 流程以「源上捕获、目标内拷贝」走端口。受保护的可编辑尾
替换与无异步间隙的组合式历史导入也移入端口命令。溯源仍留在 `history-writer.ts`，适配器
只做句柄作用域。内存替身诚实支持签发与释放，但声明 `capabilities.copy = false`，对拷贝、
尾替换与导入一律返回 `rejected('unsupported')`，任何第二后端都不能假装具备这些能力。

## 设计

```text
业务调用方 → data.snapshots.capture() → SessionSnapshot（带品牌，按存储签发）
业务调用方 → snapshot.read()           → 完整分离式存储读取（导出/回放/哈希）
业务调用方 → target.snapshots.copyFrom(snapshot, selection) → SessionCommandResult
                        ↑ 只有选择集；存储载荷不越过端口
业务调用方 → data.commands.replaceEditableTail({expectedUserTurnId, expectedForkTurnId, …})
                        → { previousUserTurnId, rollback }
业务调用方 → data.commands.applyHistoryImport({update, createCursor})
存储拆除     → SessionDocument.destroy → snapshots.closeSource()
```

`session-data/snapshot.ts` 声明品牌符号但不导出，句柄经内部工厂铸造，因此任何 JSON 值或
普通对象都无法满足该类型；运行时真伪是「句柄 → 签发记录（存储令牌、后端种类、本次捕获
载荷、签发存储的存活集合与关闭状态）」的 `WeakMap` 查询，而非形状检查。`release` 仍仅限
签发存储；`copyFrom` 依序校验：伪造 → `invalid_snapshot`、异后端 → `cross_store`、源已
关闭 → `source_closed`、已释放 → `released`，然后经共享 writer 拷贝——仍然前插业务选择
集、在任何写入前把撞 id 判为 `rejected('conflict')`，并保留捕获源中未改动的不透明内容。
跨存储拷贝之所以安全，是因为 writer 的模块级溯源表接受任意 writer 对任意文档捕获的快照；
端口只是把它收窄到同后端句柄。

Loro 适配器在共享 `HistoryWriter` 的 `capture()`/`copyFrom()` 之上实现 `snapshots`，
`read()` 走捕获的 writer 快照的分离式 getter，两条受保护命令同样只走该 writer。
`replaceEditableTail` 在 writer 的条件提交内运行共享 `planner.ts` 规则，返回 writer 的补偿
闭包与解析出的 `previousUserTurnId`；领域拒绝（`invalid_input`/`active_goal`/`stale_boundary`）
与 `HistoryWriteError` 都是写前拒绝，证明未写入。`applyHistoryImport` 把 writer 更新、
`writer.readStored()` 与游标创建绑定在同一个同步块里，游标经构造期传入的控制面访问器
（`historyImportCursor`，由 `composeSessionData` 接到控制 Mirror）写出——不存在让对端编辑
插入的异步间隙。适配器本身没有生命周期，故快照服务暴露内部 `closeSource()`，由 CLI 既有
拆除路径（`SessionDocument.destroy`）调用；未发明新的生命周期。

内存替身以相同校验码签发/释放真实句柄，但声明 `capabilities.copy = false`，对合法句柄的
`copyFrom` 以及两条受保护命令都回答 `rejected('unsupported')`，而不是假装实现自己没有的
规则。

## 消费方

Fork 在源上捕获（`sourceDoc.sessionData.snapshots.capture()`）、用 `snapshot.read()` 读克隆
边界，并经 `targetDoc.sessionData.snapshots.copyFrom(...)` 拷入目标，拒绝时映射为
`TARGET_WRITE_FAILED`。编辑重发调用
`sessionDoc.sessionData.commands.replaceEditableTail({ expectedUserTurnId,
expectedForkTurnId, replacement, fallbackGoal })`，把 `rejected` 结果映射为失败响应
（`active_goal` → `ACTIVE_AUTOMATION`，`stale_boundary` → `STALE_USER_TURN`），并在 meta
提交失败时保留返回的补偿闭包。本地项目历史同步在全部三处经一个 `applyBoundHistoryImport`
助手驱动 `sessionDoc.sessionData.commands.applyHistoryImport(...)`。业务代码不再调用原始的
`SessionDocument.captureStoredHistory/copyStoredHistory` 门面；这些原生 writer 门面与
`updateHistoryAndCursor` 仅作为兼容面保留（后者现委托端口命令，并在被拒时重建
`HistoryWriteError`）。

## 权衡

- 跨存储 `copyFrom` 只允许同后端（Loro）之间；memory→Loro 或 Loro→memory 判
  `cross_store`。因此 fork 走端口，而端口句柄的作用域仍然有效。
- 公共句柄/服务方法改为返回 `Promise`：`capabilities` 与 `release` 保持同步，而
  `capture()`、`read()`、`copyFrom()` 为 `async`。这是对最初同步签名的修订，使数据库后
  端无需阻塞调用方即可 capture/read/copy；Loro 适配器仍在 async 函数体内同步完成
  capture、分离式读取与拷贝（无 `await` 间隙），原子性不变。memory 双实现只是把方法标记
  为 async，函数体内没有可控延迟。`copyFrom` 不经过适配器的异步 `afterAccept` 钩子；
  writer 在写入前预检所有拒绝，因此 accepted 回执仍表示拷贝已应用。
- `replaceEditableTail` 把领域拒绝报成 `rejected` 而不是传播业务异常：命令自己拥有
  可编辑尾与 active goal 规则，适配器可以给出原因
  （`active_goal`/`stale_boundary`/`invalid_input`），调用方无需按消息文本匹配。这取代了
  更早的任意 `updateHistoryWithRollback(update)` 回调入口——那时业务异常只能靠文本携带
  原因。
- 回执 kind 联合新增 `'copy'`、`'rollback'`、`'import-history'`；没有消费方对它做穷举
  匹配。

## 验证

`tests/session-data-contract.ts` 按 `data.snapshots?.capabilities.copy` 分支，在两个后端
上运行新用例：伪造的 JSON 形句柄被拒绝，`release` 幂等且已释放句柄在 `read`/`copyFrom`
被拒，Loro 后端跨存储拷贝一个选择集并保留调用方从未编写的旧字段、拒绝撞 id，受保护的
回滚/导入命令在 Loro 上成功，内存替身对拷贝、回滚与导入返回
`rejected('unsupported')` 且仍对异库句柄抛错。Loro 套件覆盖 `closeSource()` 之后的
`source_closed`（同存储与跨存储）以及 `applyHistoryImport` 的游标往返。CLI 的 fork、
编辑重发与历史导入套件已改接到端口并断言行为不变；
`local-project-history-sync-service.test.ts` 显式验证内存后备的导入被拒绝。
`packages/shared` 与 `apps/cli` 的全量类型检查和测试在重定向 `HOME` 下通过。
