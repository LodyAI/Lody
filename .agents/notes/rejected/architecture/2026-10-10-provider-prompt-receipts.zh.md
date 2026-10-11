# Agent 消息幂等不进入模型 provider 协议

Status: rejected
Translation: current

[English](2026-10-10-provider-prompt-receipts.md)

## 摘要

重复推送问题涉及 Lody 内部的完成消息 Delivery。后续实现错误地将范围扩大为原生模型
的持久化接受，为 Codex 和 Claude 新增了 ACP 回执协议。用户指出职责边界后，未提交
的 client、adapter 与协议改动已撤回。所有运行时的持久化消息去重与消费确认统一由
消息编排层负责。

## 纠正与决策

之前的“provider”表述混淆了消息投递与原生模型执行。
[本地修复](../../implemented/bug-fix/2026-10-10-agent-message-idempotency.zh.md)使用
固定身份、SQLite claim、消费结算和 retired-id。重复通知只协调同一条 Delivery；
结算写入失败只重试结算，不重新执行。统一执行恢复必须阻止启动栅栏之后重新提交
Delivery，但不需要修改 ACP client 或 adapter。启动与提交之间的崩溃窗口保持不确定；
原生模型恰好成功执行一次是当前需求之外的另一种保证。

撤回的方案使用不可变文件系统认领、prompt 响应缓存和协商的 ACP 元数据/查询方法。
虽然合成测试通过，但它使修复依赖 adapter 发布链，也无法恢复丢失的流式输出。
最终不保留回执能力、Node 运行时入口、账本或新增依赖。

[Effect 指南](../../../docs/cli-effect-ts.md)区分生命周期与持久化状态。已有 Effect
恢复路径执行禁止重放的策略；SQLite 负责持久化 claim 与确认。本修复不需要全面
重写 coordinator。

## 验证

撤回检查覆盖 CLI 执行、coordinator、store 和 model 四个所属套件，以及类型检查、
局部格式、差异和文档检查。ACP 子模块与 client 源码没有本任务差异。
未执行付费原生模型或桌面验收，也不声称已部署原生运行时。
