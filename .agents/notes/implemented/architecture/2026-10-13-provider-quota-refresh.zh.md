# 按需刷新 Provider 订阅额度

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1535

[English](2026-10-13-provider-quota-refresh.md)

## 摘要

Composer 和 Agent 设置原先只展示缓存额度，没有主动获取当前值。Lody 现在把 Core 已有的 `rateLimits` 能力投影到 Provider 缓存，在符合条件的界面可见时发起独立查询。daemon 拥有短生命周期 ACP 进程并独立查询；Core 查询不创建会话，Antigravity 使用官方 usage 命令，registry Copilot 使用 SDK 账户 RPC。失败或语义含糊的空结果保留原额度；完整快照替换和更新时间仍留待后续实现。

## 契约与职责

Core 已定义 `_lody/rate_limits/get` 和 `{version: 1, query?: true}`，共享查询契约保持不变。展示要求运行时能力声明或官方 Antigravity/Copilot 兼容读取器；刷新额外要求 `query: true` 和 Machine 协议 `providerRateLimitsRefresh: 1`。仅支持推送的 Provider 可以展示缓存。builtin 的凭据／账户覆盖配置、品牌路由和 Codex API-key profile 仍不适用；自定义 ACP Provider 对自己声明的账户语义负责。

共享 UI hook 在 composer／Provider 激活、页面回到前台、popover 打开时刷新。workspace runtime 合并请求，使用已有本地控制或 Machine RPC 路由，随后协调已有 Flock handle。没有轮询、新订阅、猜测百分比或加载遮罩。

RPC 只接受已保存的 config ID 和路由标识。daemon 固定配置，复用既有启动和 profile 凭据解析，依次执行 initialize 与 Core 查询。禁用 terminal、文件系统和权限授予。Core 查询不创建会话。builtin 检查运行时已安装，避免自动安装；自定义／registry 命令保留既有启动器行为。成功返回前终止自有进程。若无法确认清理完成，则隔离该 Provider 直到 daemon 重启，避免反复生成替代进程。

请求按 Provider 和配置指纹共享所有者：成功缓存 15 秒，失败退避 5 秒，限制已完成元数据数量。并发启动沿用 ACP admission。配置变更等待前一个底层操作结束。UI 卸载不会终止共享工作。进程启动后查询超时为 20 秒，总体 signal 为 45 秒。

## 旧版 Antigravity 兼容

Google registry ACP server 1.4.5 声明 `/usage`，但未声明 Core `rateLimits` 扩展。Lody 为该 registry 条目投影自己的查询能力。查询检查服务端身份，创建独立临时目录和不带 MCP server 的 ACP 会话，等待该会话声明命令后才发送 `/usage`。缺失命令不会变成模型 prompt。同名自定义 agent 只有自行声明 Core 能力才支持查询。

分块 Markdown 的额度章节转换为一个 Provider 级 bucket，每个周／五小时窗口保留模型组名称，让现有设置与 composer 读取器展示所有组，无需猜测模型与额度池的关系。剩余百分比转换为已用百分比；零仍代表耗尽，缺失或无法解析的 UTC 重置时间保持未知。输出有大小限制；未完成、不可用或格式错误的结果失败并保留缓存。不写入 Lody 历史；上游仍可能保留自己的临时会话元数据。

所选 Provider 的官方可执行文件及账户环境保持权威。单独的 `agy` 可能选中不同登录；Google 私有接口则需要另一套凭据读取器和未公开协议。既有进程所有者、超时、清理隔离及配置／推送检查继续生效。确认进程清理后才移除临时目录；无法确认进程树结束时，隔离的 Provider 保留该目录。外部 ACP SDK 仍是 Promise 边界，此兼容查询不宣称完成原生 Effect 迁移。

## 内置 Antigravity

内置 Provider 运行官方 agy，额度查询使用与 ACP 会话相同的已选可执行文件和账户环境。它执行 `--print /usage --output-format json`，要求返回成功的 `usage` 命令且 `num_turns: 0`，严格验证每组 weekly／5h 的剩余比例和重置时间。Lody 不读取凭据。额外启动参数和 Magpie 路由暂不支持此读取器，避免查询到另一个账户。输出未知或格式错误时保留缓存额度。内置 Antigravity 允许经过核对的代理和语言环境设置，未知环境变量仍不适用。探测与真实会话快照投影相同的兼容能力，原生 Core 声明保持优先，避免缓存 writer 一概保留过时能力。

这个有时限的只读子进程由原生 Effect 命令持有：Provider 刷新触发它，取消／超时终止进程树，完成和失败交回既有刷新所有者。不创建 ACP 会话或模型轮次。上层 Provider 缓存与 ACP 流程仍保留既有 Promise 边界。新 builtin 使用独立身份；弃用的 registry Provider 保留旧启动器和会话，不做静默改写。

## 官方 Copilot 兼容

registry 条目 `github-copilot-cli` 在 SDK 模式下复用解析后的官方启动器和账户环境。Lody 将 ACP 参数替换为 `--headless --stdio`，保留包前缀及其余参数。既有 startup owner 负责启动准入和独立进程的所有权。成功、失败、超时和取消都等待进程树结束。无法确认清理完成时，沿用 Provider 隔离，不影响其他配置或聊天。SDK transport 仍是外部 Promise 边界；启动器、startup gate 和清理所有者的原生 Effect 迁移不属于此读取器范围。

读取器使用 Content-Length JSON-RPC，以 `ping` 确认 SDK protocol version 3，再调用 `account.getQuota`，不创建会话。读取器仅处理这两个顺序请求，限制字节缓冲区大小，不为只读账户查询引入通用 JSON-RPC 依赖。官方 CLI 1.0.107 和 registry 固定版本 1.0.112 都能使用已有本地登录查询。1.0.107 的 ACP 不支持账户 RPC，也没有 Core 额度声明。ACP `/usage` 只报告会话消耗，不能提供账户额度。Lody 仅为官方 registry 身份投影兼容能力，不为同名自定义命令声明支持。

只有 [0, 100] 范围内的有限 `premium_interactions.remainingPercentage` 才转换为 Core 窗口，已用百分比为 100 减去剩余百分比。零保留为耗尽；`hasQuota` 不代替数值。无限、缺失或无效额度会失败并保留缓存。通用 limit ID 使用 `github-copilot-cli`，因此选择模型不会隐藏账户级额度。基于 token 的计费使 request 数量含义不明确，实际观察到的 reset date 又接近查询时间，因此不展示数量、超额计费、固定窗口或重置时间，避免暗示月度请求数或重置预测。

[GitHub 用量指南](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing)区分账户额度与会话消耗。对固定 CLI 的本地只读验证确认了此处使用的 v3 查询，不依赖较新 SDK 的握手要求。测试仅使用合成服务端与账户数据。

## 持久化与顺序

推送和查询都使用已有 Provider 额度 writer。推送 revision 阻止较晚返回的查询覆盖新推送；写入前及 Flock 串行 writer 内再次检查配置身份。Provider key 支持自定义 agent 标识往返，legacy key 继续校验 builtin 类型。保持[Provider 隔离决策](../bug-fix/2026-09-30-provider-rate-limit-isolation.zh.md)。

Claude／Kimi v1 adapter 可能把上游失败编码为空快照。因此空查询视为未成功并保留旧行；非空结果只 upsert 返回的 bucket，不删除缺失项。本次不持久化或展示新鲜度时间。严格区分空结果与错误、完整快照替换，需要后续 adapter 契约变更。

## 替代方案与生命周期评估

复用对话连接可避免冷启动，但取消和凭据身份会耦合对话所有权。本次始终拥有独立只读连接。Core 保留公共协议定义，adapter 保留厂商请求，UI 不读取厂商凭据。

Effect feature/fix 评估发现 ACP 启动、启动 gate／transport 和 Loro 协调仍为 Promise 生命周期边界。原生迁移需要尚未完成的依赖，会超出此单元范围。因此 cache 使用小型显式 Promise owner，不宣称完成原生 Effect 迁移。更大范围继续由[迁移路线图](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md)管理。

## 验证范围

确定性测试覆盖无会话 initialize／query、能力声明、并发合并与退避、配置和推送竞态、清理隔离、严格本地路由、Machine RPC 响应、自定义 Provider key 和 UI 能力门控。另在本机通过 initialize、session/new 和 `/usage` 查询官方 1.4.5 server，确认独立的周／五小时剩余比例和 UTC 重置时间。这是额度命令，不是模型生成。`apps/cli/src/agent/acp-runner.test.ts` 的合成 ACP 流测试覆盖兼容边界；不提交捕获的用户对话。

合成协议测试不能证明已发布托管运行时产物兼容。临时版本元数据夹具不能替代匹配安装产物的验证。adapter 依赖版本和根锁文件必须保持一致，才能完成 CI 的 frozen install；workspace 的发布等待策略继续适用。
