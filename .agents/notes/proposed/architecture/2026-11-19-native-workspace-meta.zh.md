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
- **命名 Flock 文档走 SDK 所有者，而非 Lody 端口。** workspace catalog、machine Flock 和
  schedule registry 在 51 个文件、122 处直接使用同步的 wasm Flock 句柄，包括同步所需的版本和导出调用。
  逐领域写 Lody 端口被否，那正是 #2892 的模式；类 transport 适配器也被否：正文仍会持久化到本地存储
  （第二个写入方），而且 `flush` 会在 native 提交前就返回。loro-repo 的外部 Flock 所有者把副本留在内存里，
  从房间原始导出加载，应用带时钟的变化（为此新增），并经现有持久化屏障提交。
- **Session Loro 文档走 SDK 文档所有者。** 约 170 处调用通过 `DocManager` 使用
  `openPersistedDoc` 返回的 `LoroDoc`。与命名 Flock 文档同理，loro-repo 新增了外部 Loro
  文档所有者。引擎新增二进制更新订阅，因为现有文档订阅每次提交都会重新投影并对整份文档做
  JSON diff。迁移按文档、按来源懒执行，打开工作区不会导入全部 Session。
- **Session 文档留在引擎里，renderer 不持有副本。** 这是 owner 在"renderer 保留副本"和
  "拆分文档"之外的选择：Loro 导入是懒加载，真正的成本是传输并持有整份字节，而不是部分加载。
  读取使用有界列表字段读取和变化路径订阅（SDK 通用原语）；实测后未采用 JSONPath（投影不对齐、
  10 万项首次查询约 150 ms、结果无上限），也未采用逐提交 `diff`（10 万项 160–1,150 ms）。
  写入是 main 校验、引擎按 Mirror 推导出的 schema 应用的 JSON patch，并复用 HistoryWriter 的
  planner。未在 main 放写入副本，因为 `loro-crdt` 只随内嵌 CLI 打包；也未交给 daemon 写，
  因为 CLI 规则禁止代为写入。
- **一个宿主进程，由任一方拉起。** 由 daemon 持有引擎（#2895）会让 Meta 可用性绑定 daemon；
  每方各起宿主会争夺 `files.lock`。宿主在最后一条连接关闭后空闲退出。

## 后果与限制

- 启动加载仍与目录大小成正比（10 万文档 3.4 秒），因为界面要列出全部文档；逐操作延迟保持平稳
  （见设计页）。写入 p99 长尾与引擎自动压缩吻合，属 SDK 后续事项。
- 关闭开关时把 native 房间的完整原始导出合并回 CLI 副本；否决了「开关只作开发用、关掉直接回到过期旧副本」的做法，因为回写复用同一个 LWW 导入、不需要任何兼容处理。宿主死亡时已发出的提交会锁住该
  repo 的 Meta 写入，直到重建（SDK 契约）。
- renderer 不持有副本后，10 万 turn 会话的首屏热启动约 11 ms，宿主重启后约 305 ms（含启动
  宿主）；renderer 内存不随历史增长。daemon 只为运行中的会话持有副本；空闲会话的状态和历史查询直接读引擎（4 个 5 万 turn 的空闲会话：daemon 内存 +0.6 MB，原为 +254 MB；热状态读取 6 ms）。
- 云端与加密工作区不在范围内：OSS 桌面只做本地。
