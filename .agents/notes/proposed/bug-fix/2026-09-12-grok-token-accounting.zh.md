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

本审计矩阵描述 e2b55096 基线；下文后续修复仅替代明确修复的条目，不代表解决了
剩余生命周期和覆盖范围限制。

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

## 审查后续：范围内修复

2026-09-15 端点字段修正：旧持久化接口不接受顶层 webSearchRequests 和模型级
contextWindow。发送边界仅投影 Token/费用字段，contextWindow 只留在顶层。
按产品要求两个层级均省略搜索次数；Core 不变。严格的合成传输字段校验在修复前
暴露 3 项失败（含两个旧压缩测试）；投影后 16 项投递测试全部通过，保留各 Token
桶以及已知/未知费用语义。

### 投递消融实验（2026-09-15）

使用已有隔离测试 harness 运行真实投递服务，仅替换传输。先补强两个已有测试：
修改真正暂存的输入；缺失模型 map 时先 flush，再放入后续快照。基线 15/15 通过。

| 消融项                                     | 可观测结果                            | 决定                                           |
| ------------------------------------------ | ------------------------------------- | ---------------------------------------------- |
| 移除内部重复快照拷贝及重复 staged 空值判断 | 15/15 通过                            | 保留删除：入口取得数据副本，合并函数返回新对象 |
| 将最多一项的投递数组改为单个可空 payload   | 15/15 通过                            | 保留：新快照仍独立合并暂存                     |
| 移除入口拷贝                               | 1 项失败：调用方将待发送 200 改为 999 | 恢复                                           |
| 移除共享 in-flight 投递保护                | 1 项失败：发送序列变为 100、100、200  | 恢复                                           |

实验逐项执行，被否决的改动在下一项前恢复。不改 provider 源码、计价、生命周期或
持久化契约。合成测试仅证明覆盖行为，不代表生产端到端验证；全仓检查仍受依赖限制。

2026-09-14 集成结论更正：Lody main `6de01729` 已包含 #664，启动器已迁移到
多文件 profile、`dsh` 命令和逐包版本 specifier。此前启动器不兼容的结论适用于
合并前分支，不适用于当前集成结果。合入 DSH `ee8570f`，同时保留持久事件统计与
临时思考流，并取消跟踪全部生成的 `dist` 文件。DSH 构建、19 项测试、格式检查通过。
Codex 保留原生压缩取消修复及统计改动，构建和 19 项用量/通信测试通过；112 项 ACP
测试因隔离依赖缺少 Codex 可执行文件而在初始化失败。根检查仍缺工作区依赖。
官方 Harness 0.1.5-rc.2 源码仍保留正常完成请求的 usage 结构和缓存/推理桶口径；
这不代表已完成鉴权端到端验证。

关联审查 PR：[Codex #42](https://github.com/LodyAI/acp-extension-codex/pull/42)、
[Claude #26](https://github.com/LodyAI/acp-extension-claude/pull/26)、
[Kimi #10](https://github.com/LodyAI/acp-extension-kimi/pull/10)。Core #9 和 DSH #16
在原 PR 更新，消费端仍在 Lody #662。

- DSH 改为对实际注册的 `deepseek-official` route 估价。ACP 边界测试对官方与自定义
  endpoint 输入相同用量，验证只有官方路径带 USD；先前 fixture 的 route 值不正确。
- Codex 将包含式 input/output 归一化，并保留 cache creation。原生 thread 事件没有
  per-model 贡献，因此使用明确的 `codex:unattributed` 未归属桶，而不编造模型或估价键。
  会话持有统计状态，跨原生 context-window fill 重置信号和 prompt handler 保留偏移，
  返回已包含在累计值内的 delta；顶层仍保持原有累计语义。这不是持久化重启恢复。
- Claude 拆出可用 thinking，保留历史未知费率状态，上报取消结果中已消耗的用量，
  并对含子 agent 的 query model totals 求 delta。计数下降时省略 delta，不猜测新生命周期。
  SDK 未记录的 thinking 明细无法恢复。
- Kimi 从上次成功发出的 activation 快照求 delta。仓库要求的只读审查发现发送失败被
  吞掉及并发发送问题，已改为串行发送、成功后推进基线。源码修复仍需构建新的 managed
  artifact；本次不更新已有锁定 artifact，也不声称运行版本已包含这些改动。
- CLI 跨确认保留旧 Codex 偏移；带 delta 的 adapter 累计值不再走旧压缩路径。保留未知
  费用和 provider 估价，缺少 cache-write 费率时省略旧式估价而不是套用 cache-read 价格。
  Core 空聚合不再返回零费用。

合成验证：隔离依赖 harness 中 Core 3、DSH 16、Codex usage 9、Claude usage 10、Kimi
projection 7、CLI delivery 15 项通过。提取的实际 Kimi 发送方法还验证了阻塞发送失败后
补发 delta=150、重复 delta=0；已增加完整 session suite 回归，但未在完整引擎工作区运行。
Codex bundle、Core build/typecheck、DSH build 通过。完整 Codex typecheck 遇到 harness
Vitest 下无关 mock 签名错误；Claude build 遇到修改行以外的 SDK union 不匹配，lint 缺
ESLint。未声称完整工作区或鉴权 runtime 验证通过。
根 `pnpm check` 停在同一 Claude SDK 不匹配；`pnpm format` 停在 cloud-api 缺少
Prettier。定向格式化、文档检查、公共/平台边界检查通过。

仍未解决：同 ID resume/reset 需要持久化基线恢复，或消费端支持显式统计生命周期。
这些范围内修复未授权/实施私有 backend 改动、包发布、历史数据修复或 Kimi artifact
上线。Codex 未归属模型的 USD 仍未知，不能为了填值恢复按 UI 模型猜价。

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
