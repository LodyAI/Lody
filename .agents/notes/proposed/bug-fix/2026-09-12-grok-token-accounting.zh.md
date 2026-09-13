# Grok 与 DSH 用量计量

Status: proposed
Translation: current

[English](2026-09-12-grok-token-accounting.md)

旧 PR（已关闭，被本方案替代）：https://github.com/LodyAI/Lody/pull/661

当前 PR：https://github.com/LodyAI/Lody/pull/662

依赖：[Core #9](https://github.com/LodyAI/acp-extension-core/pull/9)、
[Grok #16](https://github.com/LodyAI/acp-extension-grok/pull/16)、
[DSH #16](https://github.com/LodyAI/acp-extension-dsh/pull/16)。

## 摘要

Grok 提供每个 prompt 的分模型用量，而消费端要求累计模型快照。逐条排队投递
不能修复这一语义错配，因此旧 PR 已关闭。替代方案在 Core 中新增已包含于累计值
的可选 delta，累加 Grok prompt 贡献，并接入 DSH 请求用量与 DeepSeek 官方标价
估算。合成测试验证边界；部署、重启连续性及未上报后台活动仍是限制。

## 对最初调查的更正

旧合成复现正确展示了客户端快照覆盖和失败丢失，但错误地将逐 prompt 有序投递
视为足够的计量修复。即便全部送达，累计型消费端仍需要 adapter 统一口径。
旧排队复现脚本已移除，所属行为测试改为验证修正后的契约。

Claude 顶层本轮 usage 与累计 modelUsage 有意使用不同范围，仅凭这一点不能认定
缺陷。Codex 读取 tokenUsage.total；已检查的 Kimi 激活期累加器也保留各次贡献。
本次不迁移这些 adapters，也不推断它们所有重置/桶语义均正确。
本 Note 不复制私有实现细节。

## 契约与实现

Core 0.1.5 增加可选 delta { usage, modelUsage }，累计 modelUsage 已包含该贡献。
消费端合并快照而非累加通知。共享累加器保留操作 ID/计数，单调补全迟到修正，
保留未知费用；重放和调用方修改不能增加总量。不保存 transcript 或用户内容。

Grok 两个完成通道共用原生 prompt ID。累加器接受迟到的分模型补全，跳过 replay，
顶层保留本 prompt 快照。缺少 ID 或模型归属时不猜测。保留缓存/推理从包含式到
独立桶的转换，以及 ticks / 10^10。
已检查的官方 [Grok ledger](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-chat-state/src/usage.rs)
支持整 prompt 合计，但与锁定 1.0.13 的精确源码映射仍未证明。

锁定 @deepseek-ai/dsh-session 和 dsh-llm-deepseek 0.1.1-rc.2 的包声明/实现
证实 assistant/message.data.usage 是逐请求统计，seq 是事件序号，time 是毫秒
时间戳，request/context 提供实际模型归属。DeepSeek 映射已减去输入缓存，但输出
仍包含 reasoning。Adapter 计数已提交消息而非原始 usage chunk，覆盖多个 LLM step。

2026-09-13 直接读取[官方价格](https://api-docs.deepseek.com/quick_start/pricing/)：
搜索索引已过时。Flash 已变为 V4.1，旧 V4 Flash/vision 别名也按新价格计费。
DSH 按请求完成时间和 UTC 工作日高峰规则逐请求估算，再累加 USD；未知/自定义
路由不虚构费用。不同于 flush 时重算整个会话，这不会因后续轮次跨价格边界而
改变早先请求的估价。

## 取舍与限制

- 否决：向累计消费端排队发送本轮增量，仍会偏低。
- 否决：在 Lody 内按 provider 累加，原生语义应由 adapter 负责。
- 保留：进程内确认后移除/失败重试，以及旧 Codex 压缩兼容。
- 采用：共享累加器与增补式可选 delta，兼容旧消息；活跃期保留计量 ID，
  但不是持久化账本。
- DSH 仅覆盖 ACP 所属 session 上报的事件，不虚构未上报内部/子 agent 请求。
  跨价格边界的请求按完成时间估价，不是账单。
- 未使用真实用户样本、认证 runtime 请求、私有源码公开或生产部署；
  不修复历史偏低数据。

## 验证与发布

Core 计量测试、Grok 真实 proxy 测试、DSH ACP 边界/计量测试和 CLI 投递测试
均使用合成 fixture 与注入事件时间/信号。Core 2、Grok 58、DSH 15、CLI 投递 8、
解析 12 项测试通过。Core 构建/类型检查、DSH 构建/格式检查、Grok 构建/语法检查、
文档及公共/平台边界检查通过。CLI 测试在隔离依赖目录中打包真实共享函数运行。
根 check 停在 Claude 缺失依赖，根 format 停在缺少 Prettier 的包，未声称全仓检查通过。
先发布 Core 0.1.5，再发布/重建依赖其 helper 的 Grok/DSH，最后更新消费端
产物/gitlink。本地实现本身不发布；后续及依赖 PR 已链接于上方，尚未发布任何包。

[当前投递 Spec](../../../../specs/usage-delivery.zh.md)
