# 消费已确认的编辑器快照，避免重挂覆盖未保存草稿

Status: implemented
Translation: current

[English](./2026-09-11-file-preview-replays-stale-snapshot.md)

## 摘要

主动 Refresh 后，已应用的 `externalTextUpdate` 仍留在父状态。切换预览或文件标签会重挂编辑器，新实例重放该快照，覆盖未保存草稿并清除 dirty。回执处理现在消费对应 seq，若期间已有更新的待确认事件则保留。

## 决策

- `applied` 与 `no-op` 都要消费。同文 Refresh 是 no-op，不消费就会在重挂时再打一遍。
- 用 state updater 比较 seq，避免丢掉 ack 前到达的更新事件。
- 干净编辑器重挂用最后一次已 ack 的外部文本。`subscribeText` 不会推进 `data.snapshot`；没有这个来源，Preview 再回源码会滚回打开时的快照。
- 有未保存草稿时仍用本地草稿（`hasAcceptedLocalContentChange` / dirty），不用已 ack 快照。
- 不改保存 API、磁盘写入，也不改冲突 `preservePending`。`load_with_conflicts` 在 apply 后仍保留待保存缓冲。

## 证据与限制

真实 `SessionFileContentView` + `NativeMarkdownSource` 回归覆盖有/无 Refresh 的预览重挂，以及干净文件上 `provider.saveText` 订阅更新在 Preview 再回源码后仍保留。隔离 Chromium 使用真实 Monaco 查看器、控制器和 `CodeCollabSessionFileProvider`（合成内存 runtime，不是打包 Electron）：修复前先 Refresh 再切换会丢草稿，修复后保留草稿、显式 Save，以及随后的 Refresh。Windows 0.93.3 用户报告与「先 Refresh 再切文件」一致；该二进制未映射到本提交，GitHub 无公开 `v0.93.3` release。此处未做打包 Electron 点击验收。
