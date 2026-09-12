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
后端跨存储句柄，因此真实的 fork 流程以「源上捕获、目标内拷贝」走端口。受保护的整段历史
回滚与无异步间隙的组合式历史导入也移入端口命令。溯源仍留在 `history-writer.ts`，适配器
只做句柄作用域。内存替身诚实支持签发与释放，但声明 `capabilities.copy = false`，对拷贝、
回滚与导入一律返回 `rejected('unsupported')`，任何第二后端都不能假装具备这些能力。

## 设计

```text
业务调用方 → data.snapshots.capture() → SessionSnapshot（带品牌，按存储签发）
业务调用方 → snapshot.read()           → 完整分离式存储读取（导出/回放/哈希）
业务调用方 → target.snapshots.copyFrom(snapshot, selection) → SessionCommandResult
                        ↑ 只有选择集；存储载荷不越过端口
业务调用方 → data.commands.updateHistoryWithRollback(update) → 回滚闭包
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
`read()` 走捕获的 writer 快照的分离式 getter，两条受保护命令同样只走该 writer：
`updateHistoryWithRollback` 返回 writer 的补偿闭包（`HistoryWriteError` 是写前拒绝，回调
抛出的业务错误原样传播且证明未写入），`applyHistoryImport` 把 writer 更新、
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
`TARGET_WRITE_FAILED`。编辑重发驱动
`sessionDoc.sessionData.commands.updateHistoryWithRollback(...)` 并保留补偿调用。本地项目
历史同步在全部三处经一个 `applyBoundHistoryImport` 助手驱动
`sessionDoc.sessionData.commands.applyHistoryImport(...)`。业务代码不再调用原始的
`SessionDocument.captureStoredHistory/copyStoredHistory/updateHistoryWithRollback` 门面；
这些原生 writer 门面与 `updateHistoryAndCursor` 仅作为兼容面保留（后者现委托端口命令，
并在被拒时重建 `HistoryWriteError`）。

## 权衡

- 跨存储 `copyFrom` 只允许同后端（Loro）之间；memory→Loro 或 Loro→memory 判
  `cross_store`。因此 fork 走端口，而端口句柄的作用域仍然有效。
- `copyFrom` 同步返回 `SessionCommandResult`，不经过适配器的异步 `afterAccept` 钩子；
  writer 在写入前预检所有拒绝，因此 accepted 回执仍表示拷贝已应用。
- `updateHistoryWithRollback` 原样传播业务异常而不是包成 `rejected`：CLI 按消息映射错误
  码的路径依赖这一点，且这类异常发生在 writer 的 produce 步骤内、证明未写入。
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
