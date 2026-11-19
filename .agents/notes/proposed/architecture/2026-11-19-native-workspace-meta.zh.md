# 在现有 Repo API 之下接入 native Workspace Meta

Status: proposed
Translation: current
Language: [English](2026-11-19-native-workspace-meta.md)

## 摘要

一个显式开启的本地模式把 Workspace Meta 从两份旧 Meta Flock 副本（CLI SQLite、renderer
IndexedDB）迁到一个 native loro-repo-rs 房间。独立宿主进程持有引擎；daemon 和桌面 main
各保持一条连接；renderer 经 main 的领域 IPC 访问。现有 `LoroRepo` 调用方保持原 API，
因为 repo 使用增量 external metadata 适配器。旧 Meta 经 LWW 导入迁移，并做有界覆盖校验。
实现需要两个 SDK 新增能力，已作为 loro-repo #306、#307 合入 main（`0fa4fb92`），尚未发版。验证仅在 Linux：真实宿主进程、
真实 CLI document manager 与 1 万/10 万基准；未跑打包桌面。实现设计见
[native Workspace Meta](../../../docs/native-workspace-meta.md)。这是
[被拒的 native Repo 记录](../../rejected/architecture/2026-10-16-native-workspace-repo.zh.md)
要求的新提案；[WorkspaceData 提案](2026-10-14-workspace-data-services.zh.md)仍拥有长期目录契约，两者都保持有效。

## 决策与被否方案

- **保留 `LoroRepo` API，只替换 Meta 所有者。** 约 370 处调用使用
  `getDocMeta`/`upsertDocMeta`/`watch`；改写成新端口对一刀可审阅的改动太大，被否。
  loro-repo v1 external metadata 契约也被否：每次更新、回执和读取都传完整目录快照，
  控制器整体克隆、排序、比对，等于重现 #2892 被关闭时的逐操作全房间扫描。新的
  `loro-external-metadata-v2` 只传变化行，读取走索引视图。
- **从当前头部订阅，分页读初始状态。** 变化订阅的初始快照上限为一页（4096 行/1 MiB），
  整个目录（1 万文档即 3 万寄存器）无法观察；Flock 前缀按整段元组匹配，无法按领域拆前缀。
  引擎新增 `snapshot: false`；客户端读取有界的 `start` 分页，每页在各自头部读取，
  不用并发写入会作废的游标；缓冲的变化按 `roomTxId` 逐键合并。
- **以导入而非重写迁移。** 扫描后重写会生成新时钟并丢失删除记录。导入完整旧 JSON
  导出保留寄存器；重复或过期来源在 LWW 下无害，因此同一步骤可供之后的工作区导入复用。
  用 `flockReadRegisters` 校验被否：它一帧返回整个房间（10 万文档时失败）。改用有界状态比对；
  对不同的键再导入一次而状态不变，即证明已有更新的寄存器覆盖它们。
- **一个宿主进程，由任一方拉起。** 由 daemon 持有引擎（#2895）会让 Meta 可用性绑定 daemon；
  每方各起宿主会争夺 `files.lock`。宿主在最后一条连接关闭后空闲退出。

## 后果与限制

- 启动加载仍与目录大小成正比（10 万文档 3.4 秒），因为界面要列出全部文档；逐操作延迟保持平稳
  （见设计页）。写入 p99 长尾与引擎自动压缩吻合，属 SDK 后续事项。
- native 写入后关闭开关会看到冻结的旧目录；反向导出是下一刀。宿主死亡时已发出的提交会锁住该
  repo 的 Meta 写入，直到重建（SDK 契约）。
- 云端与加密工作区不在范围内：OSS 桌面只做本地。
