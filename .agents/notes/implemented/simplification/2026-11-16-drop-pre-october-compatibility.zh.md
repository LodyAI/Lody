# 移除 2026 年 10 月中旬以前客户端与状态的兼容

Status: implemented
Translation: current

[English](2026-11-16-drop-pre-october-compatibility.md)

## 摘要

2026 年 9 月到 10 月中旬的几次删除留下了一次性迁移和拒绝处理器，让旧桌面端、旧 daemon 和本地状态能平滑升级。各自的笔记都写明：等到受支持的版本不再产生旧请求或旧数据时就删除。2026-11-16 owner 决定一次性删除，而不是让每一项无限期保留。现在 daemon 会拒绝只有 2026-10-16 以前桌面端才发送的请求，读取更早状态的一次性逻辑也已删除。代价落在一个月内跳过所有版本的机器上：旧草稿留下的 worktree 不再被清理，旧桌面端连接新 daemon 时会收到不支持请求的错误。当前客户端或共享文档仍在使用的持久化格式有意保留。

## 决定

删除以下兼容代码：

- **草稿预备请求。** daemon 不再处理 `session/prepare` 与 `session/prepare-cancel`；[移除草稿预备](2026-10-16-remove-draft-session-preparation.zh.md)曾为旧桌面端保留即时空应答。
- **Code Collab v1 宿主启动。** daemon 不再处理 `session/code-collab-host-start`；当前桌面端和 Web 都不发送它。
- **预备 worktree 恢复。** 删除 `legacy-speculative-worktrees.ts` 及其在 Session 创建时的认领和启动清扫。2026-10-16 以前 daemon 预备的标记和 worktree 不再被认领或删除。
- **发送日志迁移。** 删除 `legacy-session-send-migration.ts` 以及 `force-cache`/`force-all` 清缓存标志值。任何带 tag 的桌面版本都没有发布过 `lody-session-send-v1` 日志（它只存在于 2026-09-15 至 2026-09-29 之间）；[移除发送日志](2026-09-29-remove-session-send-journal.zh.md)曾计划在“几个版本之后”删除。
- **PR poller JSON 导入。** 删除把 `pr-poller-state.json` 导入 SQLite 的一次性逻辑。仍有该文件的机器只会重置一次轮询配额与冷却；PR 状态本身保存在 Session 元数据中。
- **v1 以前的托管运行时元数据。** 不符合当前 schema 的安装元数据按缓存未命中处理，最坏情况是重新下载一次运行时。
- **未关联的配额预约。** 不再识别和阻断 `claude-quota-continue` v1/v2 快捷方式的 Schedule id。这些是 2026-10-31 以前、在五小时配额重置时触发的一次性任务；[配额预约决定](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.zh.md)中按 Turn 关联的交接不变。

## 有意保留

- Loro 会话与机器 meta 的旧字段以及 `normalizeLegacyAcpSessionConfig`：旧 Session 文档是共享历史，会一直保留这些结构。
- daemon 对 `needToArchiveSessions` 的丢弃：已发布的移动端版本仍会写入，尽管当前移动端代码已停止写入。
- turn-diff 存储对旧 schema 的识别：该本地缓存格式随带 tag 的版本发布过，没有它旧数据库会报 “unknown schema”。
- 依赖私有后端的回退（`legacy-unclassified` 工作区准入、缺少 `repositoryId` 的 PR 行、`includeVersion` 与 `historyBatch` 回退）：删除前需要后端补数据或部署。
- E2EE 线上格式与存储格式：一经发布不得变更。

## 备选方案

- **每项单独设定支持窗口。** 各笔记都写了自己的条件（“等到受支持的 daemon 不再产生它们”），但 Lody 没有记录最低客户端版本，这些条件永远无法核验。统一按日期切断让决定保持明确。
- **把 worktree 清扫改为一次性清理而非删除。** 保留清扫可以清掉从未升级机器上的孤儿 worktree，但要保留约 600 行代码和一次启动扫描，只为处理当前 daemon 从不写入的状态。

## 影响

- 2026-10-16 以前草稿留下的孤儿 worktree 会一直留在磁盘上，直到用户手动删除；分支和对话不受影响。
- 早于 2026-10-16 的桌面端配合新 daemon 发送草稿预备时会看到错误，不再收到静默的 `duplicate`。
- 只有在记录了最低支持客户端版本的前提下才重新引入兼容路径，这样它的删除条件才可核验。
