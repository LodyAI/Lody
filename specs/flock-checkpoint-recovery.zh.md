# Flock checkpoint 恢复

Status: draft
Translation: current

[English](flock-checkpoint-recovery.md)

## 行为

升级或重启后，已持久化的本地修改仍然可用。同步 checkpoint 不得跳过当前
已加载副本缺少的记录。Flock 的普通和 inclusive 版本向量都是最大时钟摘要，
不能证明所有 key 都存在。

接受的远端数据必须先保存，再推进同步进度。持久化回调必须等资源写入完成，
不能只安排稍后保存。保存失败保留待写数据，并阻止 checkpoint 推进。

Renderer 的 Meta 和 named Flock 通过 loro-repo 的 IndexedDB 副本能力一起
恢复数据和 checkpoint。不复制旧独立 Flock cursor；没有新 checkpoint 时，
首次连接重新 bootstrap 并合并本地数据。Renderer 原有 LoroDoc cursor 独立保留，
不属于此 Flock 保证。Meta 恢复标记绕过实际绑定的 checkpoint。

CLI 保留 SQLite CRDT 数据，但不复用旧持久 cursor。上游 SQLite 支持原子副本
恢复前，Flock 进度只属于当前内存对象，文档也使用内存进度。重建 transport 或
重启进程会重放远端数据，代价是额外下载，不是丢弃未上传的本地修改。
local-only 组合不启动云同步。

## 边界与验收

不改变传输和 snapshot 编码。不保证旧 writer 与新 writer 共用数据库仍安全，
也不保证回滚后保留新的持久化保证。历史远端 snapshot 已缺失的数据需要可信的
重放或恢复证据；不能凭版本向量相等就发布声称已经修复的 snapshot。

验收覆盖旧 IndexedDB 布局迁移、本地记录保留、同向量补 key 后重开、重叠副本
进度隔离、保存失败重试、实际 checkpoint 的恢复绕过，以及本地链路转发后来
收到的低时钟 key。浏览器断电和生产远端历史完整性需要单独验证。

## 证据

- [上游修复](https://github.com/loro-dev/loro-repo/pull/132)
- [实现决策](../.agents/notes/implemented/bug-fix/2026-09-17-flock-checkpoint-migration.zh.md)
