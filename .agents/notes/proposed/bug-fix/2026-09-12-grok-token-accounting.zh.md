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

## Builtin 审计更正（2026-09-13）

Adapter 测试通过不代表端到端投递正确。CLI 原先只接受 managed runtime，
因此排除了 builtin `deepseek`。接收端现改用 builtin catalog，服务类型改为
`BuiltinAgentType`；不把 DSH 加入 managed 下载，也不为 local composition 启用云服务。

| Provider | 已检查的范围 / delta                                                       | 剩余不一致                                                                        |
| -------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Grok     | 当前分支累计 prompt/model 贡献并返回 delta                                 | 新进程丢失基线，同 ID 恢复需要连续性；尚未证明源码与锁定 runtime 精确对应。       |
| DeepSeek | 当前分支累计已提交请求并返回 delta；新会话分配新 ID                        | 本次修复接收端过滤；未上报的内部请求仍不在覆盖范围。                              |
| Claude   | query 累计 model totals 包含子 agent；未返回 delta                         | resume 在同一 session ID 下新建 query；clear/reset 也会重置 SDK 计数。            |
| Kimi     | 锁定 f255222661c9 按 model/子 agent 累计 activation 以来用量；未返回 delta | resume 保留 session ID，但建立新统计基线；修改子模块不等于更新 managed artifact。 |
| Codex    | 锁定 0.153.4 返回 thread 累计值；无 modelUsage/delta                       | 包含式桶违反 Core；当前模型回填会错归旧用量；重置偏移不能跨成功 flush 保留。      |

锁定的 [Codex decoder](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/codex-api/src/sse/responses.rs)
中 input 包含 cache read/write，output 包含 reasoning。其合成例子 input=100、output=10，
其中 cached=40、cache-write=60、reasoning=5。执行当前 adapter 映射后独立桶求和为
155，而非 110，且漏了 cache creation。正确独立桶应为 0 input + 40 read + 60 write

- 5 output + 5 reasoning。[原生协议](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/protocol.rs)
  还会在填满 context window 时重置计数；`last` 不是 exactly-once delta。
  Claude 的 [SDK 契约](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
  区分最新轮主 agent 用量与 query 累计 model totals，并说明重置行为。

使用实际提取的接收端/adapter 方法和本地检查的消费端 reducer 执行合成验证，未公开
私有源码：DeepSeek 原先被丢弃，修复后五个 builtin 均接收且仍排除 custom/未知 provider；
模型 A=100 后模型 B=thread-total 200 得到 300；同一统计键下先 1000，再新统计生命周期
的 200 不产生增量。实际 Codex 投递服务在分别确认的 1000 / 0 / 200 flush 之间也丢失
偏移。这是代码级复现，不是用户实测或鉴权 runtime 调用；重置 fixture 证明消费端行为，
不证明重置发生频率。

解析器对五个 provider 都保留可选 delta；旧持久化接口仍只接收快照。本次尚未为
Claude/Kimi/Codex 新增 delta producer：Kimi 已有原生差分，Claude 需要明确 query 基线，
Codex 先需归一化并解决模型/生命周期归属。不能编造 delta 费用，也不能默认把顶层 usage
当作完整 delta。

下一步需选择：Core 与消费端贯通显式 accounting-lifetime identity，或恢复持久化累计
基线。每条通知随机生成身份、盲加可重放 delta 都不能替代这一设计。尚未修复生命周期，
也不声称所有 provider 完全合规。隔离 harness 中 13 项投递、16 项解析测试通过。
指令要求的 `context/message-flow.md` 在此 checkout 不存在；接收端改动仅限 provider 筛选。

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
