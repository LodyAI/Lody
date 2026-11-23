# 升级 Loro Repo，以快速路径加载已存储的 Flock 文件

Status: implemented
Translation: current

[English](2026-09-29-loro-repo-fast-flock-hydration.md)

PR: [LodyAI/Lody#1113](https://github.com/LodyAI/Lody/pull/1113)

## 摘要

在 loro-repo 0.21.0 上，渲染端每次在 IndexedDB 中压缩工作区元数据 Flock 时，都会把整个 Flock 全量重建一遍。2026-09-29 的一份 Web profile 显示：一次 `Flock.recoverFromFile` 调用耗时约 1.19 s，调用来自 `compactMetaSnapshot`，之后还有约 500 ms 的 `exportFileV2Incremental`。Lody 现在固定使用 loro-repo 0.21.1，它用 `importFile` 而不是宽松恢复来打开已存储的 Flock 文件。问题与文件格式无关：采样到的帧全部位于 v2（`FLK2`）路径，没有执行任何 v1 代码。

## 决策与证据

- **耗时拆分。** 在这次恢复调用内部，`recover_v2_raw_entries_from_bytes` 解码全部条目（357 ms），`rebuild_from_raw_import_entries` 再经 `apply_three_tree_write_set` 把它们全部写回（813 ms）。`loadReplica` 和 `readFlockDoc` 也走了同一路径，分别耗时 17 ms 和 8 ms。
- **原因。** [loro-dev/loro-repo#132](https://github.com/loro-dev/loro-repo/pull/132)（0.20.3）把共享的 `hydrateMetaSnapshots` 辅助函数从 `Flock.fromFile`/`importFile` 改成了 `recoverFromFile`/`recoverImportFile`。这样做是为了在把写入更新日志的远端 Streams 字节合并进 base 之前，丢弃其中损坏的条目。但同一个辅助函数也用来打开本地写入的 base 快照，而 `MetaPersister` 会周期性触发压缩。结果是每次压缩和加载都会解码并重建整个存储。
- **修复。** [loro-dev/loro-repo#142](https://github.com/loro-dev/loro-repo/pull/142) 随 0.21.1 发布，所有已存储的 Flock 文件都改为经过 `importFile`。把干净的 v2 文件导入空 Flock 时，它先校验各表的 CRC，再以 O(1) 惰性采用该文件。文件被拒绝时，flock-wasm 自己会改走 `recoverImportFile`，因此检测到的损坏仍然只丢弃无法读取的条目。0.21.0 → 0.21.1 的包差异只涉及 `dist/flock-snapshot.*` 和版本号，公开类型声明没有变化。
- **上游测量。** 上游在 Node 中用 10 万条目（640 KB 文件）测量：打开 base 从 530 ms 降到 2.6 ms，一次本地写入后的导出从 147 ms 降到 6.5 ms。
- **Lody 侧改动。** 共享 catalog 的版本固定、精确版本的发布时间例外，以及仅针对该包的 `@loro-dev/streams-crdt` peer 允许版本，都从 0.21.0 改为 0.21.1。peer 范围仍然是 `^0.15.0`。锁文件只改变了 loro-repo 的版本、完整性哈希和带 peer 限定的引用。这是 [loro-repo 0.21.0 持久化迁移](../architecture/2026-09-27-loro-repo-flock-persistence-migration.zh.md)的后续；副本绑定的 checkpoint 和 #132 的其他持久化修复保持不变。

## 验证与局限

- 对比了已发布的两个 tarball：`diff -r` 显示只有 Flock 快照辅助模块和 `package.json` 有变化。
- 使用 pnpm 10.20.0 通过 `pnpm install --lockfile-only` 重新生成了锁文件。
- 提速效果尚未在 Web 应用中重新 profile；上面的数字来自上游在 Node 中的测量。
- 表校验和有效、但记录格式错误的 base 不再被急切解码，因此这些记录在读取时会被隐藏，与 0.20.3 之前一样。Lody 从不写出这样的 base。
