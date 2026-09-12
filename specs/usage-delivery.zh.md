# 客户端用量投递

Status: draft
Translation: current

[English](usage-delivery.md)

云投递不可用期间若完成多个 Grok prompt，后续 flush 必须按顺序发送每个
已接收 prompt 的用量，不能让最新 prompt 覆盖早先用量。Token 桶和缺失费用
的含义保持不变。

客户端排队保存 Grok prompt 合计，不改变托管请求格式，也不构造 Session
累计值。其他 provider 保留现有快照合并和 Codex compaction 处理。队列按
workspace、Lody session、ACP session、user 隔离，每份 payload 保留自身归属。

收到 `{success:true}` 后才移除该 payload。请求拒绝、异常或未成功确认均将
该记录保留在新更新之前，等待下一次 flush。并发 flush 共用一个发送过程，
失败即结束本次尝试；成功发送期间到达的新更新由同一过程继续发送。缺失模型
用量仍不能持久化，但不能阻塞后续合法记录。

这仅提供进程内投递，不是持久账务。它不能恢复修复前已丢失的数据、抵御进程
退出、修正上游不完整快照，也不能证明托管端的增量/累计或确认丢失语义。
这些契约需要另行核实；本次保留正常逐 prompt 请求序列，不选择新的聚合规则。
OSS local 组合仍完全禁用云用量服务。

## 证据

- [实现与行为测试](../apps/cli/src/lib/usage/usage-tracking-service.test.ts)
- [调查与剩余限制](../.agents/notes/proposed/bug-fix/2026-09-12-grok-token-accounting.zh.md)
