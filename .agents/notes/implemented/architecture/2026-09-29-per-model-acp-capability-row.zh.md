# 每个模型的 effort 与 Fast 支持单独存一行

Status: implemented
Translation: current
Language: [English](2026-09-29-per-model-acp-capability-row.md)

## 摘要

Lody 对每个 agent config 只保存一份能力条目，内容取自某一次 `session/new` 的响应。
而 ACP agent 每次切换模型都会重建推理强度列表和 Fast 开关，
所以这份条目只描述了 agent 恰好启动时的那个模型，其他模型显示的也是它的推理强度和 Fast 开关。
有用户把 Codex 的默认模型设成 `grok-4.6` 之后，所有模型的这两个控件都消失了。
Claude 和 Codex 适配器其实已经在 `_meta.lody.modelCapabilities` 中报告每个模型的控件，但宿主从来没有读取。
现在 Lody 把这份报告按模型存进单独的 `acpModelCapability` 机器 Flock 行，
所有读取方都按所选模型解析推理强度和 Fast。

## 问题

- **存储的快照**：`['acpCapability', configId]` 行保存的是某一次 `session/new` 的 `configOptions`，
  每次 probe 和每个新建 session 都会重写它。其中的推理强度列表和 Fast 选项属于那次响应当时的模型。
- **已有的按模型数据**：`modelReasoningEfforts` 只来自 Codex 旧式的 `model[effort]` id，
  以及 Grok 的 `_meta.lody.modelReasoningEfforts`。没有任何按模型的 Fast 信息。
- **各自绕开**：UI、CLI 校验和 MCP 的运行配置解析各自绕开这份快照，例如 Codex 的手工档位表。

## 决定

- **读取**：`readAcpModelCapabilitiesMeta` 解析 v1 报告
  （`{ version: 1, models: { [modelId]: { effortValues?, fastMode? } } }`）。
  版本未知，或者任一模型条目格式不对，就整份丢弃，避免把缺失的模型读成「不支持」。
- **存储**：`['acpModelCapability', configId]` 保存 `{ version: 1, sourceVersion, models }`。
  - 两个写入方都通过 `updateAcpCapabilities` 传入报告：刷新 probe，以及新建 session 的回写。
  - 值中没有时间戳，所以报告不变就不产生写入和同步。
  - 响应中没有报告时，不动已有的行。
  - capability 行及其去重比较保持不变。
- **读取时合并**：`getMachineFlockAcpCapabilities` 在该行的 `sourceVersion` 与 capability 行一致时，
  把其中的模型信息作为 `declaredModelControls` 附到条目上。它不会写进 capability 行。
  各读取方在 Flock 读取中加入这一行类型。
  `MachineDocument` 仍然只读 capability 行：它的去重要比较写入时的原值，而且它要响应严格的
  `machine/acp-capabilities-refresh_response` schema。
- **使用**：
  - UI 选择器使用所选模型报告的推理强度列表。Codex 也包括在内：报告会取代手工档位表。
  - UI 选择器对报告为不支持 Fast 的模型隐藏 Fast；对报告为支持、但 probe 时没看到的模型，补上内置的 Fast 开关。
  - CLI 校验和 MCP 解析通过 `getModelEffortChoices` 读取推理强度（报告优先）。
  - 报告中的 Fast 信息从不作为拒绝请求的理由。
  - 没有报告的模型保持现有行为。

## 声明与适配器实际提供的控件

对第一版的评审发现了三个缺口，现已修复。共享的内置绑定（`getBuiltinModelControlBinding`）记录了每个内置适配器的
effort 选项 id，以及它如何发布这个控件。未知 agent 没有绑定，Lody 也从不猜测它们的 id。

- **Claude 的 `default`**：Claude 在模型支持的档位之外，还会发布一个 `default` effort 选项。
  它表示清除 effort 固定值、跟随 provider 的默认，只要客户端没有协商 AIR `recommendedValue` 就会出现，
  而 Lody 没有协商。声明中只列出档位。因此 `resolveDeclaredEffortSupport` 会为 Claude 补上 `default`，
  并把它作为回退值。`getModelEffortChoices` 让 UI、CLI 和 MCP 使用同一份列表，
  所以 `effort=default` 不会被改写成 `medium`，也不会被拒绝。
- **控件缺失**：如果 probe 时的模型没有 effort 控件，已声明模型的 effort 会使用内置适配器自己的控件
  （Claude 的 `effort`、Codex 的 `reasoning_effort`）。
- **不支持与未知**：
  - 声明为空列表表示模型没有 effort，控件隐藏；
  - Claude 恰好在模型没有 effort 时省略 `effortValues`，所以对 Claude 而言，已声明但没有该字段的模型就是不支持；
  - 对其他适配器，省略表示未知，保持现有行为。
- **Role 切换模型**：应用 Role 时，会用切换前模型的选择器过滤 Role 的值。
  当 Role 同时切换模型时，effort 和 Fast（`isPerModelControlConfigId`）即使在切换前的模型上没有对应控件，
  现在也会原样透传，随后由选择解析按切换后的模型校验，所以从没有 Fast 的模型切走时，`fast=true` 得以保留。
- **Role 编辑器切换模型**（[#1308](https://github.com/LodyAI/Lody/issues/1308)）：
  编辑器显示 agent 的默认值，并在第一次编辑时把它们存下来。默认值只填未设置的字段，
  所以把 Claude Code Role 从有 Fast 的模型切到没有 Fast 的模型时，`fast` 被保留，
  composer 也就始终匹配不上这个 Role。现在切换模型时，编辑器会按切换后的模型构建选择器，
  新模型仍接受的已存值都保留。新模型不再提供的值会被丢弃，例如没有 Fast 的模型上的 `fast`、
  不在新档位里的 effort，再由默认值补齐。没有对应选择器的值保留；重新选择当前模型不做任何改动。
  曾考虑重置权限以外的所有选项，因为会连 Plan 和仍有效的 effort 一起丢掉而放弃。
- **MCP**：
  - 声明为没有 Fast 的模型，会拒绝 `fastMode=true`，并把 `false` 视为无需操作；
  - 声明为有 Fast、但 probe 时没有该选项的模型，会使用内置的 Fast id。

## 局限

- **显示可能过时**：在 Lody 之外更换账号或权益，要等到下一次 probe 或新建 session 带回新报告时才会反映出来。
- **并发写入**：还没有写入序号防护，同一 config 的两个并发 probe 可能乱序写入。只影响显示。
- **旧客户端**：旧客户端会忽略新的行类型，行为与之前一致。
- **Role 编辑器中未声明的 Fast**：没有声明时 Lody 保留 probe 得到的选择器，所以如果 probe 时的模型有 Fast，
  在没有 Fast 的模型上新建 Role 仍可能存下 `fast`。已经存了不受支持值的 Role 不做迁移。

## 验证

- shared 测试覆盖：
  - 解析报告，以及报告无效时整份拒绝；
  - 推理强度的解析以报告优先；
  - 合并时的来源版本门控。
- `machine-document-capabilities.test.ts` 检查写入行为：
  - 报告变化时只写一次；
  - 报告不变时不写；
  - 响应中没有报告时保留已存的行。
- `acp-selector-options.test.ts` 检查界面显示的是所选模型自己的推理强度列表和 Fast 开关，
  没有报告的模型保持不变。
- 逐一移除三个机制（按报告取推理强度、Fast 规整、读取时合并），每次都有对应测试失败。
- `agent-role-form.test.ts` 覆盖 Role 编辑器切换模型：新模型接受的值和没有选择器的值保留，
  不再提供的 effort 和 `fast` 被丢弃。
- 尚未验证：真实适配器的端到端流程。
