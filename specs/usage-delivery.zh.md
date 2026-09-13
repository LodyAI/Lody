# 用量快照与投递

Status: draft
Translation: current

[English](usage-delivery.md)

多个请求在投递前完成时，最新计量快照仍须包含全部用量。Adapter 负责原生
计数语义，Core 负责公共契约，消费端持久化累计快照而非累加通知。
Local 组合仍完全禁用云用量服务。

## 契约

`modelUsage` 是同一 ACP 计量生命周期内的分模型累计值。`usage` 是最近操作
快照（旧 provider 可能不同）。可选 `delta` 携带自上次发出更新后新增计入的
合计与分模型桶，已包含在 `modelUsage` 中，不能再次累加。增量通知不是
exactly-once 账本。缓存读/写、普通输入/输出、推理桶互不重叠。未知费用省略而非填零。

Replay 不新增用量，模型切换与压缩不清零。新计量生命周期必须使用新的消费端
计量身份或恢复基线；进程内状态不保证重启连续性。Grok 在两个完成通道之间
按 prompt 标识贡献，允许单调补全。DSH 按持久化请求事件标识贡献，使用请求
实际路由而非 UI 当前模型。

## 投递与估价

CLI 合并待发累计快照，包括 Grok。失败 payload 保留原归属直至确认，
并发 flush 共用发送过程。delta 不再加到总量，也不传给旧持久化端点。
Codex 原有压缩兼容处理保持独立。

是否接收用量取决于 builtin agent catalog（包含 DeepSeek Harness），而非 managed
下载列表。收到 provider 的 delta 不证明其累计值已符合生命周期契约；
[builtin 审计](../.agents/notes/proposed/bug-fix/2026-09-12-grok-token-accounting.zh.md#builtin-审计更正2026-09-13)
记录了尚未解决的 adapter 归一化和 resume/reset 问题。

DSH 按请求完成事件时间，使用官方 UTC 工作日高峰/非高峰价逐请求估算美元，
再累加费用。未知路由、自定义端点或缺失时间戳不虚构价格。价格表有日期，
不是账单；跨价格边界的请求可能与账单不同。Runtime 未报告的活动无法计入。

## 证据与发布

- [Core 契约](../packages/acp-extension-core/src/usage.ts)
- [DSH 测试](../packages/acp-extension-dsh/src/usage.test.ts)
- [Grok 测试](../packages/acp-extension-grok/test/proxy.test.js)
- [投递测试](../apps/cli/src/lib/usage/usage-tracking-service.test.ts)
- [调查更正](../.agents/notes/proposed/bug-fix/2026-09-12-grok-token-accounting.zh.md)

先发布 Core 0.1.5，再构建/发布依赖累加器的 adapters，之后更新消费端 gitlink/
产物。本地修改不发布包、不修复历史数据，也不证明线上托管行为。
