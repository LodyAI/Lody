# 带版本轮次 hash 与 primitive 元数据插入

Status: implemented
Translation: current

[English](2026-09-14-versioned-history-hashes-and-primitive-metadata.md)

## 摘要

新的历史写入现在把普通元数据字符串存为 primitive，只为真正流式增长的字段创建
`LoroText`，长会话不再为成千上万个不必要的文本容器付出开销。与此同时，导入用的规范
轮次 hash 带上了版本：没有版本的已存 cursor 或基线视为 v1；v2 哈希规范化 item 形式，
使被封存的 tool_call 骨架与封存它的完整调用得到相同 hash；会话文档 cursor 独立记录自己
`importedTurnHashes` 的版本，与同步元数据的 `replayDigest` 版本互不影响。两项变更都是
插入/比较策略，接在当前共享导入 planner
（`packages/shared/src/session-data/history-import.ts`）和 `applyHistoryImport` 上：
打开已存历史不产生任何写入，遗留 Text 和 primitive 值保持原有表示，任何旧 payload
都不会被重新解析。封存骨架的读取端特性本身不在本次实现；这里只提供它所需的 hash 与
cursor 兼容性。

## 问题

两股压力在一次存储变更中交汇。

其一，历史 item 的 catchall 原本是 `schema.Any({ defaultLoroText: true })`。工具调用里的
每个新字符串——`toolCallId`、`status`、`title`、`kind`、`locations[].path`——都会变成
`LoroText` 容器。一次工具调用可能产生十几个从不流式增长的容器，其数量正是长会话打开与
同步昂贵的原因。schema 注释早已反对深度 Text 推断，但代码却背道而驰。在未修改的 main
（375c4c7e）上实测：`toolCallId`、`status`、`title`、`kind`、`locations[].path`、
`command`、`args[]`、`cwd`、`terminalId` 以及 step 的 `command`/`output` 全是 Text 容器。

其二，外部历史导入比较的逐轮 hash 可能出自不同的规范形式。旧文档 cursor 存的是 v1
hash，而较新的同步元数据可能已前进到 v2，且冲突标记只更新元数据。把 v1 cursor 与 v2
hash 直接比较，会在内容未变时制造假的 `prefix_mismatch`。#376 之后，cursor/replay 类型、
哈希、基线校验和导入决策都归共享 session-data 端口所有，因此版本化属于这里——而不是
CLI 侧的重复实现。

## 存储插入策略

`historyItemAnySchema` 现在是 `schema.Any({ defaultLoroText: false })`，普通元数据存为
primitive。流式字段在 `schema.ts` 中显式声明并保留 `LoroText`：

- 外层 `text`（`text` 与 `thought` 共用）和 `markdown`；
- 工具调用的 `content`，通过 `storageSchema` 提示；
- worktree 脚本的 `steps`，通过 `storageSchema` 提示。

嵌套的工具/worktree payload 遵循同一规则：catchall 默认 `defaultLoroText: false`，只声明
真正流式的 payload 字段——工具 `text`、工具 `output`、ACP `content` block 嵌套的
`content.text`、worktree step 的 `output`。该层级的其余字段（`terminal_command.command`、
`args`、`cwd`、diff 的 `path`/`oldText`/`newText`、`terminalId`、`input` 值、
`steps[].command`/`status`）都是元数据，存为 primitive。#584 的第一版曾把整个嵌套子树默认
为 `defaultLoroText: true`，仍把每个元数据字符串建成 Text，存储目标未达成；其审计发现了
这一点。新值是 primitive，而已存的旧 `LoroText` 在同类型编辑时保留容器 id，因为 writer
按已存储的容器种类做 diff，而不是按新 schema。

该策略只影响插入，writer 独立于 schema 保证这一点：

- `diffMap` 在同类型字符串编辑时保留已存储的表示：旧 `LoroText` 保留容器 id，旧
  primitive 保持 primitive；
- 未知已存字段和未触碰的不透明 item 绝不重写；
- 畸形的旧值（例如存成 Map 的 `locations`）不阻塞无关字段编辑，因为只有 authored 变更
  会被解析。

`schema.ts` 与 `history-materializer.ts` 不再把该提示描述为等待 `loro-mirror` 补丁。锁定的
2.3.2 读取器已在上游携带 text-event 优化；`storageSchema` 提示只被共享 materializer 读取，
历史写入全部经过共享 HistoryWriter，而不是 `Mirror.setState`。

## Hash 版本

`packages/shared/src/session-data/history-import.ts` 定义 `HASH_VERSION_V1 = 1` 和
`HASH_VERSION_V2 = 2`，CLI 同步服务把新导入物化为 v2。v1 原样哈希
`{ role, items, plan }`；冻结的 v1 字节由固定夹具钉住（规范测试轮次为
`cc7ec54e…5935`）。v2 规范化每个 item：

- `tool_call` 只保留 `type`、可选字符串 `title`、`kind`、`status` 和 `locations`——即封存
  骨架保留的字段——因此去掉 `toolCallId`、`content`、`rawInput`/`rawOutput`、`ref`、运行时
  标注和权限请求不改变 hash。`title: null` 与缺失 title 哈希相同。
- `text`/`thought` 只保留 `type` 和 `text`，丢弃派生的 `spans`。
- 其余 item 丢弃同一组易变键。

一个明确记录的取舍：因为 v2 把工具 payload 排除在身份之外，只改变工具输出字节的来源侧
变更本身不会触发刷新。

`resolveStoredHashVersion` 把缺失版本视为 v1。文档 cursor 的 `hashVersion` 字段给自己的
`importedTurnHashes` 标版本，`ExternalAcpHistorySyncMeta.hashVersion` 给元数据
`replayDigest` 标版本。二者独立，因为冲突标记可能只更新元数据。两者不一致时，决策从
物化 replay 历史按已存版本重算 hash，而不是跨版本比较；重算不改变轮次数，因此
`appendFromIndex` 仍然索引物化历史。若版本不一致且没有可重算的 replay 历史，决策直接
抛错而不是猜测，端口报告为写入前拒绝。

已存内容基线记录其计算所用的 hash 版本，旧基线不会被当作 v2 解读，现有 v1 规范化规则
不变。字段出现之前写入的基线没有 `hashVersion`：与 cursor 比较时视为 v1
（`(baseline.hashVersion ?? 1) === cursorVersion`）。直接比较原始可选值会拒绝每个真实的
旧基线（`undefined !== 1`），丢弃投影出的已存历史，把正常追加误报为
`local_history_has_untracked_suffix`。版本绑定仍会在任一方向拒绝真正的 v1/v2 不一致
（服务套件中有直接覆盖）。

`HistoryImportCursorSchema` 显式声明 `hashVersion`：Zod 在端口边界剥离未声明的键，丢掉
版本会把 v2 cursor hash 静默 reinterpret 为 v1。`applyHistoryImport` 按已存 cursor 的版本
计算投影后缀，并在既有的无 await 提交块内以 replay 的版本写入新 cursor；历史变更之后的
cursor 写失败仍是 indeterminate，绝不是 rejected。

## 备选与边界

- 恢复旧 #584 的 CLI 侧哈希被否决：#376 之后共享端口拥有 cursor/replay 类型、哈希与决策，
  在 CLI 重复同一策略会再造一个策略写点。
- 为消除不一致而放宽写入校验被否决：那是在隐藏畸形新输入，而不是给 hash 标版本。
- 丢弃已存版本或把 v1 cursor 当 v2 解读被否决：那是用假冲突换静默的 hash 损坏。
- 嵌套工具/worktree catchall 保持 `defaultLoroText: true` 被否决：容器增长只是下移一层，
  `command`/`path`/`args` 仍是 Text，存储目标未达成。
- 封存骨架契约——读取侧的 `ref` payload 拉取、`useToolCallPayload` hook 及消费它的
  UI——**不在**本次实现。v2 规范形式与之向前兼容，但只用合成夹具验证。读取端后续留在
  #586，本次不变更它。

不声称 3000 轮验收、payload 体积缩减或 E2E 验收。这是一次存储插入与 hash 比较变更，
不是窗口化读取器或附件外置的落地。

## 证据

- `packages/shared/src/{schema,history-materializer}.ts`、
  `packages/shared/src/session-data/{history-import,loro}.ts`
- `packages/shared/tests/history-storage-policy.test.ts`（新增）、
  `session-history-import-port.test.ts`（带版本端口矩阵）、`history-writer.test.ts`
- `apps/cli/src/lib/local-project-history-sync-service.ts`
- `apps/cli/tests/local-project-history-sync-service.test.ts`、
  `local-project-history-sync-writer.test.ts`（真实无版本 v1 基线升级）
- [单一 history writer](2026-09-07-single-history-writer.zh.md)（本次之前的所有者；其中
  “不做 #359 hash-v2 rollout”一行描述的是更早 PR 的范围，不是当前行为）
- Spec：[会话历史写入](../../../../specs/session-history-writes.zh.md)
- 取代 PR #584（已关闭未合并；其 CLI 归属早于 #376）。
