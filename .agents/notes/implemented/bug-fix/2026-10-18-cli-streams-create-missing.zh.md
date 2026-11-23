# CLI 负责创建由它首次 join 的 Streams

Status: implemented
Translation: current
PR: [#1680](https://github.com/LodyAI/Lody/pull/1680)

[English](2026-10-18-cli-streams-create-missing.md)

## 摘要

改用原生 Repo 和 Streams 之后，由 CLI 或 agent 的 `lody_session_create` 创建的
会话在所在机器上照常运行，但其他客户端永远打不开：云端的会话 stream 不存在，
每次 bootstrap 都返回 `stream_not_found`。原生 `loro-repo` transport 把
`createStreamIfMissing` 默认设为 `false`，而它取代的 Legacy transport 默认是
`true`。只有渲染端会为自己发起的会话显式建 stream。CLI transport 现在重新把这个
选项设为 `true`，首次 join 时会建好 stream 并上传本地状态。Code Collab 的
file-index Flock stream 也因此得到覆盖。已经卡住的会话，在装有此修复的 daemon
下次 join 时就会恢复。它们的数据在本地从未丢失。

## 事故

2026-10-18，一台机器上通过 MCP `lody_session_create` 创建的四个子会话，在另一台
电脑的桌面客户端里加载不出来。daemon 日志中这四个会话（且只有它们）都是同样的
顺序：先是 `Session dispatch not yet confirmed by Loro Streams (session.create:…:doc)`，
8 秒后是 `Session doc initial sync timed out, continuing offline-first`，之后是
无限重试的 `stream_not_found` bootstrap。本地 153 个会话文档里，恰好只有这四个
没有云端会话流游标，它们的本地快照和更新都完整。file-index（`fi`）Flock stream
对父会话同样返回 404。前两天的日志里没有出现过 `stream_not_found`。

## 原因

[#1607](https://github.com/LodyAI/Lody/pull/1607)（见
[release adoption](../architecture/2026-10-16-streams-repo-release-adoption.zh.md)）
把 CLI 从 `loro-repo` 0.22 的 Legacy Streams transport 换成了 0.23 的原生
`makeStreamsTransport`。发布出来的包能直接看到默认值的翻转：

- 0.22.0 的 `dist/transport/streams.js` 在 meta、doc、flock 三种房间上都使用
  `createStreamIfMissing: this.options.createStreamIfMissing ?? true`。
- 0.23.1 的 `dist/effect/streams.js` 使用
  `createStreamIfMissing: options.createStreamIfMissing ?? false`。CRDT SDK 的
  文档说明，这个选项允许首次 join 在 404 时创建 stream。

Lody 的两个 transport 都没有传这个选项。渲染端仍会为自己发起的会话预先建 stream
（`createRemoteStreamLegacy`），所以从 UI 发起的会话不受影响。CLI 或 MCP 发起的
会话、Code Collab 的 Flock 文档，都没有人预先建 stream。它们一直靠首次 join 自动
创建，升级后这一步悄无声息地消失了。

## 决定

`createCliStreamsTransport` 设置 `createStreamIfMissing: true`，CLI join 的所有
房间都恢复升级前的行为。file-index Flock 的 TTL 依然生效，因为 SDK 在自动创建时
同样会带上 `streamTtlSeconds`。

考虑过的替代方案：

- **在 CLI 的创建路径里显式建 stream。** 这样还得覆盖 Code Collab 的 Flock 文档
  和今后所有由 CLI 发起的房间，而且修不好已经卡住的会话。join 时创建能在一处把
  这些全部解决。
- **在渲染端也恢复默认值。** 渲染端自己发起的会话不受影响。它的 Flock 房间是否
  需要这个选项是另一个问题，本次修复不做判断。

取舍：如果某个房间的 stream 在远端被删除了，CLI join 时会重建一个空 stream，而不是
把 404 暴露出来。这正是升级前 CLI 的行为。

## 验证

`apps/cli/tests/cli-streams-replica-checkpoints.test.ts` 用真实的 CLI transport
对接一个脚本化服务器，该服务器在收到 stream 级 PUT 之前一律返回 404。会话文档
join 时会建好 stream 并追加本地 turn。file-index Flock join 时会带着保留期 TTL
建好 stream。把选项改成 `false` 时，这两个测试都会失败。生产环境那四个会话的
恢复还没有实际观察到：需要装有此修复的 daemon 重新 join 它们。

当前边界（2026-10-19）：已撤回原生消费者及其后续应用补丁，仍选择 Repo 0.23.2；恢复的 Promise transport 自带远端 Stream 创建行为。见[撤回决策](../simplification/2026-10-19-repo-upgrade-without-consumer-migration.zh.md)。
