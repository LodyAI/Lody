# Streams 同步失败诊断

Status: draft
Translation: current

[English](streams-sync-diagnostics.md)

## 场景

工作区或会话同步失败时，`Streams sync failed: internal_error` 这样只有错误码的
消息无法区分请求失败、本地游标故障和 CRDT 故障。Lody 应展示失败边界已掌握的证据，
并在现有本地诊断输出中记录相同的安全上下文。

## 职责

Streams 在操作失败的位置记录来源。Repo 通过 transport 结果、同步报告和诊断事件
保留原始 discriminator、经过验证的 context、明确的重试属性和故障分类。Lody 将这些
已定义的标量字段投影为技术错误详情和日志。调用方包装和多 transport 报告必须保留
有用的失败信息。

详情区分网络请求、截止时间、HTTP 响应、本地存储、本地 CRDT 操作和未知来源，并展示
已观测到的系统错误码、HTTP 状态/request ID、operation/stage，以及上游提供的实测
超时预算。fetch 失败或 errno 不能证明设备断网或后端宕机；HTTP 错误证明收到了响应，
不能证明服务停机。没有证据时保持未知，禁止根据消息文本推断来源。

日志将错误关联到现有诊断事件提供的工作区、room、transport、phase、耗时和 attempt。
只输出安全投影，不输出完整异常、任意消息、stack、cause、body、headers、provider
对象、密钥、token 或 URL 查询。现有本地化操作标签包围技术详情。普通非 Streams
错误保留现有格式。

诊断只负责观测，不改变重试、transport 选择、持久化或同步截止时间。明确的
`retryable: false` 必须保持 false。正常成功同步保持安静。现有 local-only 组合与
禁用遥测约束继续适用；诊断不增加云请求。

## 证据与限制

实现：[共享投影](../packages/shared/src/loro-sync-errors/index.ts)、
[CLI 组合](../apps/cli/src/lib/loro/streams-transport.ts)、
[renderer 组合](../packages/components/src/providers/workspace-streams-transport.ts)。
决策与验证：[归属 note](../.agents/notes/implemented/bug-fix/2026-10-10-streams-sync-error-context.zh.md)。
合成故障测试可验证传播和安全格式化，无法在缺少底层证据的情况下认定原始生产事故的原因。
