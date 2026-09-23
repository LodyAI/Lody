# 会话摘要中的实际模型

Status: draft
Translation: current

[English](session-model-summary.md)

## 场景

会话列表应展示最近一次助手回复实际使用的模型，无需订阅每份会话正文。
为下一条提示选择不同模型，不应改变上一条回复的模型标签。

## 契约

拥有该会话的 CLI 将最近一个助手历史条目的 `modelInfo` 投影到可选的
`SessionMeta.lastModel`，只保留 `modelId` 和 `name`，不包含提供方扩展元数据、
启动设置或请求的输入配置。修改更早的助手条目不能替换最新条目的模型；
回退历史时应根据保留的历史重新计算。没有 items 且没有 plan 的助手条目不算回复，
与正文渲染器隐藏这些条目的行为一致。

摘要字段缺失表示生产者尚未提供摘要；`null` 表示观察到的历史没有助手回复；
空对象表示存在助手回复但模型未知。消费者不能把字段缺失理解为会话从未运行。

投影只跟随正常工作中已经打开的文档，不能枚举并打开历史房间。
流式内容没有改变模型时不能重写目录。投影仅读取角色、模型标识和 items/plan 数量，
不能物化 turn 正文或不透明的模型扩展 payload。发布串行执行，不阻塞提示发送；
失败在下一次文档变化或 flush 时重试。现有持久化与 Streams 传输负责交付。
隐藏的 fork 目标和已删除会话不得被发布；fork 提交使目标可见后，无需等待下一次
历史变化就应发布摘要。持久化 fork 提交后的投影失败，不得终止目标、清理其
worktree 或生成失败回执。去重比较当前目录值，因此下一次历史变化或 flush
可以修复被旧 metadata 覆盖的摘要。

## 限制与证据

旧生产者和未打开的历史会话可能没有摘要。这是新增的展示字段，不是派发输入或批量迁移。
本契约不新增多所有者并发或任意混合版本回滚保证。

- `apps/cli/src/lib/loro/session-model-summary.ts` 及其行为测试。
- `apps/cli/src/lib/loro/doc.ts` 与其他写观察者一起挂载 `sessionData.history` 投影，
  临时快照读取不挂载投影。
- [决策](../.agents/notes/implemented/feature/2026-09-12-session-model-summary.md)。
