# 避免并发 Loro 导入时重放全部历史

Status: implemented
Translation: current
Related: [English](2026-09-28-loro-concurrent-import-replay.md)
Pull request: [#1098](https://github.com/LodyAI/Lody/pull/1098)

## 摘要

Lody 0.100.0 用户报告了并发 Loro 更新时 renderer 卡顿。Loro 1.15.1 遇到交叉依赖历史时，`find_common_ancestor` 可能退回到最初的分叉点，随后为每个有改动的 Text/List tracker 从文档历史开头重建状态。Lody 升级到 `loro-crdt` 1.16.3，其中包含上游修复 `d9ddfba19` 和 `80a0e8821`：使用较新的多头关键版本作为重放基点，并让仅包含 register 更新的并发导入从当前版本重放。随任务提供的本地基准从 500 ms 降到 4 ms；但无法确认用户现场的具体文档和容器。

## 决策

将共享 catalog 和 CLI 依赖固定到 1.16.3。`@loro-dev/loro-cli@0.6.0` 声明了精确的 `loro-crdt@1.15.1` 普通依赖，因此增加仅针对该包的 pnpm override，使 lockfile 只包含一份 1.16.3。检查到的 `loro-repo@0.21.0`、`@loro-dev/streams-crdt@0.16.0`、`loro-mirror@2.3.2`、`loro-adaptors@0.6.1` 和 `loro-websocket@0.6.2` peer 范围均允许 1.16.3。安装时，仓库的七天新版本隔离尚未到期，因此将这个精确版本加入允许列表。

## 上游行为与 API 核对

- `d9ddfba19` 调整重放基点选择，改用最新的多头关键版本，避免报告的 criss-cross 形状从很早的分叉点重放。
- `80a0e8821` 允许仅有 register 更新的并发导入从当前版本重放。
- 1.16.0 CHANGELOG 还记录了有界的解码容器缓存、更快的浅快照导出、拒绝与浅快照根并发的更新，以及新的容器批量深读 API。容器上的 `getDeepValueWithID()` 返回的 `cid` 从 debug 复合字符串改为规范容器 ID。Lody 生产代码没有调用该容器 API，也没有解析其 `cid`；一个测试 helper 调用的是已有的文档级 `LoroDoc.getDeepValueWithID()`。生产代码中已有的 `LoroDoc`、Text/List/Map 容器、导入/导出和版本向量调用均使用 1.15.1 已有的 API。
- 1.16.3 还会拒绝插入属于另一个文档的容器。这收紧了无效跨文档插入的行为；Lody 没有依赖这种操作。

## 证据与限制

上游 `loro-crdt@1.15.1` 到 `loro-crdt@1.16.3` 标签范围包含两项重放修复。任务提供的本地基准使用 40 个 Text 和 40 个 List 容器，两个 peer 交叉同步 2,000 轮，再做一次并发导入；1.15.1 为 500 ms，1.16.3 为 4 ms。该数据来自任务描述，本次没有重新运行。我们无法检查受影响用户的原始文档、具体容器组合或 renderer trace，因此无法确认该报告对应的就是这条上游慢路径。验证结果记录在 PR 中。
