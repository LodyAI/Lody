# 基于已公布模型组合的 Devin Fusion 配置器

Status: implemented
Translation: current
Language: [English](2026-11-14-devin-fusion-builder.md)

## 摘要

Devin 把 Fusion 公布为“每个主模型与副模型组合对应一个 `model` 值”，因此 Lody 的模型菜单列出几十个 `Fusion (… + …)` 名称，却无法像 Devin Desktop 那样分别选择主模型、副模型、主模型推理强度和快速模式。对官方运行时做的零推理 ACP 探测表明：不存在独立的 Lead 或 Sidekick 配置项，组合只能通过已公布的值选择；主模型推理强度（`thought_level`）和快速模式（`speed`）则是该模型下真实存在的选项。Lody 新增 Fusion 对话框，把已公布的值整理为主模型与副模型选项，禁用 Devin 未提供的组合，并通过 composer 现有的编辑通道只提交一个已公布的模型值及该模型自身的推理强度与 Speed；下一轮会话应用这些设置，Devin 回报的状态即为确认。在 Devin 开放独立控制之前，任意配对仍被上游阻塞。一次真实的 prompt 已抵达执行路径并死于配额耗尽——Devin 自己的回合统计给出了应用了推理强度与快速模式的组合名——因此配置链路已验证到执行准入层；主模型与副模型的实际回合内容仍未验证。

## 证据

条件：macOS arm64，Devin CLI 3000.12.28（适配器固定的运行时版本），`acp-extension-devin` 32e125a，已登录账号。只发送 `initialize`、`session/new` 和 `session/set_config_option`，分别直接发往 `devin acp` 和经由适配器，并将 `DEVIN_SESSIONS_DIR` 指向临时目录。没有发送 prompt，原始通信只保存在本地。

- `session/new` 返回 `mode`、`model`（扁平的单选项，共 145 个值，其中 88 个为 `fusion-*`）、`thought_level`（类别 `thought_level`）和 `speed`（类别 `model_config`，取值 `standard`/`fast`）。没有主模型或副模型配置项，每个模型选项的 `_meta` 只有 `cognition.ai/supportsImages`。
- Fusion 值的形式为 `fusion-<主模型及其默认推理强度>-sidekick-<副模型>`，名称为 `Fusion (<主模型> <推理强度>[ Thinking] + <副模型>)`。9 个主模型与 10 个副模型共 90 种组合，缺少的两种恰好是以主模型自身的模型作副模型。副模型的推理强度是副模型取值的一部分（`SWE-2 Medium`、`SWE-2 High`），因此不存在单独的副模型推理强度。
- 选择 Fusion 值后返回完整选项列表，其中包含该主模型的强度档位（`low` … `max`），默认值即 ID 中的档位。设置 `thought_level` 或 `speed` 不改变模型值；切换到另一组合时推理强度重置为该组合的默认值。适配器声明有 17 个组合不支持快速模式；实测的两个组合（Claude Fable 5.2 与 Claude Sonnet 5.5 主模型搭配 SWE-2 Medium）完全不返回 `speed`。未公布的值返回 `-32602 Invalid params`，状态不变。这些调用之后没有收到 `config_option_update` 通知。
- Devin 私有的模型目录缓存在 Lead、Effort、Sidekick、Fast Mode 四个维度上描述了 795 个 Fusion 配置，说明 Devin 自身的选择器同样是对已枚举配置的浏览。Lody 不读取该缓存。
- 应用 `fusion-gpt-6-sol-high-sidekick-swe-2-medium` 加 `thought_level=medium`、`speed=fast` 后发送 `session/prompt`，返回 `-32011`（每日配额耗尽），且 `_cognition.ai/turn_stats` 通知报告 `cause: quota_exhausted`、`modelLabel: "Fusion (GPT-6 Sol Medium Thinking Fast + SWE-2 Medium)"`——运行时自身的标签渲染的是应用后的推理强度与快速模式（ID 中的 `high` 只是默认值），确认配置已抵达执行准入层。工具调用为零，没有产生真实回合内容。

## 决策

- `lib/devin-fusion.ts` 只从值和名称都符合 Fusion 形式的选项构建目录，其余选项仍留在普通模型列表中。只有 ID 与名称一致时，主模型标签才去掉默认推理强度一词。查询只返回已公布的值：未公布的组合没有对应值，禁用“应用”，并提示 Devin ACP 未提供该组合。
- 推理强度和快速模式来自 composer 为该组合模型构建的选择器（`useAcpModelSelectorResolver`）：即已记录的选项或适配器声明；若 Lody 只能借用其他模型的控件，则不提供。切换组合时，若原推理强度仍可用则保留，否则重置并显示提示；组合没有 `speed` 时关闭快速模式。
- “应用”通过普通的 composer 编辑写入模型值、`thought_level` 和 `speed`。对话框会说明 Devin 的运行时基线（`acpRuntimeConfig`）是否已与之一致；否则从下一条消息开始生效，届时 CLI 依次应用模式、模型和其他选项，被拒绝的模型仍以 Agent 警告的形式显示。不会在回合进行中途应用，也没有第二条执行路径。
- `normalizeFastModeSelectors` 将 Devin 的 `speed` 单选项视为其按模型提供的快速模式控件，因此声明不支持快速模式的模型既不显示、也不发送从其他模型借来的 `speed` 值。

## 备选方案

- 独立的 Lead 与 Sidekick 控件：ACP 3000.12.28 不提供，需要 Devin 公布相应选项。
- 根据标签拼接 `fusion-*` ID：拒绝；运行时会拒绝未公布的值，界面也会错误描述实际运行的内容。
- 在 Lody 中读取 Devin 的目录缓存，或新增 `_meta.lody.fusion` 声明：既然已公布的值和名称已经包含组合信息，就没有必要；而且两者都会引入新的私有或协议依赖，需要维护者同意。
- 用两个普通 Agent 模拟 Fusion：拒绝；那不是 Devin 的编排器。

## 影响与限制

- 只有内置 Devin 且存在可解析的 Fusion 值时才显示入口，位置为会话 composer 和新对话页；移动端、定时任务和子标签草稿仍使用原列表。
- 命名形式变化时退回扁平列表，不会臆造组合。
- 既没有已记录选项也没有声明的组合，在刷新该 Agent 的能力之前使用 Devin 的默认设置。
- 不显示价格，因为 Devin 未通过 ACP 提供经过核实的价格信息。
- 未验证：真实 Fusion 回合的内容（配额探针止于执行准入），以及桌面应用连接实时运行时的表现。

## 验证

- `packages/components/tests/fusion-builder.test.tsx`：目录解析、标签、未公布组合、控件、组合切换、应用编辑、运行时确认、对话框渲染与菜单入口条件。
- `packages/components/tests/acp-selector-options.test.ts`：Devin 的 `speed` 跟随声明的快速模式支持。
- `packages/components/src/stories/FusionBuilderDialog.stories.tsx`：对话框各状态。

相关：[按模型存储的能力行](../architecture/2026-09-29-per-model-acp-capability-row.zh.md) 与 [按模型记录的选项](../../proposed/architecture/2026-11-11-observed-model-config-options.zh.md)。
