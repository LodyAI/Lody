# Grok Token 偏低调查

Status: proposed
Translation: current

[English](2026-09-12-grok-token-accounting.md)

## 摘要

本次调查针对 Grok Token 统计偏低反馈，没有用户原始样本。合成验证证实同一次 flush 前的多个 prompt 会丢失早先用量，持久化请求失败也会丢失已暂存的数据。后续修复实现了按顺序投递 prompt、成功确认后才移除失败待发记录，保持正常逐 prompt 请求语义和 Token 换算。用户实际触发条件、托管端聚合以及精确发布源码映射仍未验证。本 Note 因这些更广的计量问题保持 proposed，已实现的客户端投递修复及其限制记录如下。

## 范围与版本证据

- Lody：`2055c001696ce508f075ac4e776d8bb93e112997`；Grok adapter 0.1.3：`c962338e3e6e68858e0bf92e9671a84b9a07e055`；Core 0.1.4：`0710756b1e257bfd3630d196e02fdf998e758989`。
- [Runtime manifest](../../../../packages/acp-extension-grok/runtime-manifest.json) 锁定官方 `@xai-official/grok` 1.0.13。下载的[官方 npm 平台包](https://registry.npmjs.org/@xai-official/grok-darwin-arm64/1.0.13) tarball SHA-1 为 `1da22c03bd828189662ed0ebc22788669e74bdc3`。Brotli 解压后 133486016 字节，SHA-256 为 `8669e0fdadceec25b8c159c355f427ffbd82583525d774b6ab1522197ea83b80`，与[托管 runtime 可执行文件锁定值](../../../../apps/cli/src/agent/managed-agent-runtime.ts)完全相符。仅执行 `--version`，输出 `grok 1.0.13 (5e9a58528b76)`；没有发起模型或账单请求。
- 检查的官方公开源码提交为 `37949780c144e37df692e3d669051a21fec24f20`。没有找到对应 1.0.13 tag，获取二进制短构建号对应 ref 也失败。因此源码支持契约判断，但**尚未证明与锁定二进制完全一致**。adapter 既有测试是合成数据，不能视作 runtime 实测。
- 操作仅涉及当前独立工作树和临时目录，没有读取用户配置、原会话目录、transcript、凭据、托管后端源码，也没有访问生产业务接口。

## 调查基线的假设与复现结果

| 假设 | 证据与结论 |
| --- | --- |
| 缓存/推理重复相减 | 检查的公开源码不支持此假设。[PromptUsageModel](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L193) 的缓存读取/创建属于 input，reasoning 属于 output。adapter 将 `(1000,250,300,100,50)` 转为 `(600,200,300,100,50)`，总量仍为 1250；去掉减法反而会计为 1700。仍需锁定 runtime 的隔离 fixture 或发布源码映射补齐精确版本证据。 |
| 只统计最后一次 LLM 请求 | adapter 读取 `_meta.usage`，不是旁边的 `_meta.inputTokens/outputTokens`。官方[响应元数据测试](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/agent/mvp_agent/prompt_response_meta_tests.rs#L87)和[ledger](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-chat-state/src/usage.rs#L107)支持整个 prompt、多调用、按模型累计。`numTurns` 是主循环调用数，不应再乘到已累计的 tokens 上。没有发现 adapter 只取最后一次调用的问题。 |
| 多回合增量/累计混淆 | **已证实客户端丢量。** adapter 每个 prompt 发一次；`UsageTrackingService.applyUpdateToState` 除 Codex compaction 外均覆盖 `staged`。同一次 flush 前依次输入 1250、2500，实际只发 2500，丢失 1250，即合计 3750 的 33.3%。`MessageHandler.runTurnCloudSideEffect` 离线跳过 flush，是云组合中积累多个 prompt 的具体路径。 |
| 每回合都成功 flush | 实际发出 `[1250,2500]`，不是 Session 累计快照 `[1250,3750]`。Core [usage 类型](../../../../packages/acp-extension-core/src/usage.ts)没有声明增量/快照、事件标识；公开[云 DTO](../../../../packages/cloud-api/src/index.ts)的 `upsertSessionUsageFromCli` 没有说明聚合算法。如果托管端按累计快照处理，正常多回合也会偏低；**后端行为未验证**，不能根据方法名认定。 |
| 首个不完整统计抢先去重 | **已证实条件性行为，未证实线上触发。** `usageForPrompt` 接受任意对象，包括 `{usageIsIncomplete:true}`、`{}`，缺失字段归零后就记住 prompt ID。合成的不完整 prompt 响应先到、完整 `turn_completed` 后到，会丢失后者的 1250 tokens。公开源码正常完成路径共用冻结后的 usage，尚无证据证明该路径先后返回不同合计。 |
| modelUsage 丢失 | adapter 保留多个模型行；解析器和 `AgentClient.sanitizeModelUsage` 保留五个 Token 桶。map 缺失且存在当前模型时，AgentClient 会用总 usage 补一行。两者都缺失时服务跳过持久化；直接调用服务的合成 fixture 证实了这个保护条件，**没有证明**正常 Grok 会话缺失模型。非空但不完整的 map 也没有与总 usage 校验对账。 |
| UI 漏加独立桶 | 已检查的输入、解析与合并路径均保留五个桶。`session-usage.ts` 和会话 popover 显示上下文占用、限额，不是历史计费 Token。工作区图表直接使用服务端 `timeline.totals.tokens`，分解包含 input、output、缓存读取+创建、reasoning。没有发现本地漏加桶公式；服务端计算和用户具体查看的界面仍未知。 |
| 持久化失败 | **已证实另一条丢量路径。** `flushKey` 在 mutation 前清空暂存；失败只记日志，随后 cleanup 删除空状态。合成请求失败后再 flush，不会重试。MessageHandler 附近“失败后保留合并合计”的说明不符合已发起 mutation 的失败行为；离线跳过 flush 则只保留最新暂存值。 |

代码定位：[proxy](../../../../packages/acp-extension-grok/src/proxy.js) 120–157、231–239、537–542、800–810、874–885 行；[解析器](../../../../apps/cli/src/agent/lody-acp-extension.ts) 81–96 行；[AgentClient](../../../../apps/cli/src/agent/agent-client.ts) 305–341、1474–1480 行；[统计服务](../../../../apps/cli/src/lib/usage/usage-tracking-service.ts) 168–218、223–258 行；[MessageHandler](../../../../apps/cli/src/lib/message-handler.ts) 1055–1138 行；[工作区图表](../../../../packages/components/src/components/settings/usage-calendar-visualization.tsx) 798–821、1938 行；[会话用量](../../../../packages/components/src/lib/session-usage.ts) 100–117 行。

## 完整性、重放与费用

公开上游[freeze 逻辑](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs#L1703)区分 prompt 与 session ledger：后台子任务可能在 prompt 快照之后完成，后续花费只计入 Session。`usageIsIncomplete` 因而可能表示真实 Token 缺口，不只是费用未知。adapter 在抑制费用后丢弃完整性标记，也没有对账 Session 计费 ledger。这是公开上游支持的待验证限制，不是用户案例实测，也不能证明仅改去重即可找回后台子任务用量。

`isReplay:true` 的完成事件不发账单更新是有意行为，去掉保护会重复统计恢复的历史。缺失 ID 会绕过去重，256 个 ID 的缓存也不是持久账务身份。这两种风险更倾向重复计量，不能解释已复现的偏低。

`costUsdTicks / 10_000_000_000` 与公开上游一致，fixture 中 250000000 ticks 得到 $0.025。`usageIsIncomplete` 和行级 `costIsPartial` 省略费用但保留 Token。未知费用不应变成零；当前 Grok 未使用的 merge 路径会把缺失的模型费用按零合并，因此不能不加审查地直接复用。

OSS local 平台明确配置 `usage:null`，上述云统计服务在该组合不工作。修复不能给 local 添加认证产品云请求。首先应确认反馈指的是托管工作区统计、上下文占用，还是另一种供应商计数。

## 修复建议与必要下一步

1. Core、adapter 和客户端共同明确计量单位（prompt 增量或 Session 快照）、稳定事件标识、完整性及替换规则。在精确 runtime 证据推翻前，保留包含式转独立桶算法。不能修改 Spec 来合理化当前口径冲突；后续保证变化需 draft 和双语文档。
2. 对已证实的 flush 前丢量：若下游需要 Session 快照，应累计不同 prompt 增量且不因 flush 丢失累计基线；若下游接收事件，应持久化幂等 prompt 记录。先核对托管端公开契约再选择。盲目相加会重复计算原本累计的 provider；只让 Grok 走现有 merge helper 不能解决重试、重启、不完整更正。
3. 成功写入后才推进已确认基线、移除待发送记录。用确定性的请求拒绝/重试、写入中到达新事件 fixture 验证；下游必须有幂等身份，不能直接重试非幂等加法写入。
4. 保留完整性和 prompt 已计入贡献，允许有证据的更完整结果作差额更正，避免双计。空/不完整对象不能伪装为最终统计。后台子任务可能需要上游 Session 用量来源；现有上下文与账单限额刷新不能替代 Token 对账。
5. 下一轮仅收集脱敏结构化诊断：客户端/adapter/runtime 版本及 hash、产品界面和时间范围、不透明 prompt ID、事件顺序、Token 桶、`modelUsage`、完整性/replay 标志、flush 结果。覆盖两个 prompt、多次调用的工具循环、受控后台完成/取消；对比上游 ledger、传输边界和托管响应。fixture 不应包含原始 prompt、模型文字、路径、凭据或真实 transcript。

## 验证与交接

### 用户授权后的实现，2026-09-13

已在 `UsageTrackingService` 修复已确认的客户端丢量：Grok 更新立即进入有序队列，
其他 provider 保留快照合并和 Codex compaction。每份待发送记录保留归属，收到
`success:true` 才移除。失败结束本次发送，后续 flush 重试；并发调用共用同一发送
过程，发送途中到达的新记录继续按顺序处理。没有修改 adapter、Core、托管 API DTO、
模型归属、费用换算或 local 组合。[投递 draft](../../../../specs/usage-delivery.zh.md)
记录了进程内保证。

该实现保留联网客户端原本逐 prompt 发送的请求序列。若在 adapter 改成累计快照，
或在客户端累加增量，会选择尚未核实的托管聚合规则，可能引入重复统计。成功投递
仍不能证明托管合计正确。服务端提交后确认丢失的重试依赖托管 upsert 的幂等契约，
本次不宣称新的 exactly-once 保证。队列只在内存中，离线期间可能增长，进程退出
仍会丢失待发送数据。不完整结果抢先去重、后台任务晚到用量仍是上述 adapter/上游
待确认问题，没有宣称一起修复。

更新后的离线复现脚本断言 1250 和 2500 都发出（合计 3750），失败重试携带完全
相同的 payload。所属 Vitest 测试覆盖 prompt 顺序、全部桶/未知费用、调用者修改
隔离、拒绝与未成功 ACK、并发 flush、发送期间新记录、累计 provider、Codex
compaction、ACP session 隔离。测试执行当前服务，只替换 HTTP mutation 边界。
以下早期调查验证记录为修复前版本的历史结果。

后续验证：隔离 esbuild bundle 加 Vitest、使用符合 catalog 的 Convex 客户端，
服务测试 **8/8 通过**；更新后的研究断言和既有 proxy 测试 **56/56 通过**。
变更 TypeScript 文件通过定向 Prettier 与 esbuild 编译，平台边界检查通过。
已尝试 CLI typecheck，但无依赖的嵌套工作树缺少 `tsgo`，无法启动。
没有宣称完成完整应用构建/check 或部署。

[离线复现脚本](2026-09-12-grok-usage-repro.mjs)打包执行**当前真实** proxy/Core 与统计服务，只替换服务的网络客户端、DTO 引用和错误格式化器。断言检查输出/待持久化 payload，不依赖 sleep 或网络；同时打包既有 proxy 测试。在仓库根目录执行：

```sh
grok_usage_tools=$(mktemp -d /tmp/grok-usage-tools-XXXXXX)
npm install --prefix "$grok_usage_tools" --ignore-scripts --no-audit --no-fund esbuild@0.28.2
node .agents/notes/proposed/bug-fix/2026-09-12-grok-usage-repro.mjs "$grok_usage_tools/node_modules/esbuild/lib/main.js"
# 执行 node --test <脚本输出的 bundle 目录>/existing-tests.mjs
```

研究断言通过，打包后的既有 proxy 测试 **56/56 通过**。这验证 proxy 行为和服务本地输出边界，不等于 AgentClient/MessageHandler 端到端执行、官方模型运行、托管持久化或 UI 渲染实测。官方 Rust 行为测试仅阅读、未运行。当前嵌套工作树未安装根依赖，且没有产品代码变更，因此未运行完整应用 typecheck/build/test 或 `pnpm check`/`pnpm format`。未提交 commit，也未创建 PR。

开始时 `pnpm run docs status` 报告 20 个已有失效链接，主要涉及未初始化的无关子模块；初始化 Core 后，最终 `pnpm run docs check` 因剩余 15 个已有失效链接失败，本次研究 Note 没有检查错误。不在此修复无关链接或刷新 SHA 基线。没有已注册的保护主题。相关[用量分享 Note](../../implemented/feature/2026-09-09-usage-share-image.md)仅负责展示，本提案补充计量调查，不替代其原有决策。
