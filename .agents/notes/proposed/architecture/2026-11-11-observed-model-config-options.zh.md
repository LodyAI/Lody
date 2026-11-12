# 在用户请求的刷新中读取每个模型的配置选项

Status: proposed
Translation: current
Language: [English](2026-11-11-observed-model-config-options.md)

## 摘要

每个 Agent 配置只保留一份能力快照，其中的 `configOptions` 只描述拍快照那一刻的当前模型，
因此适配器没有声明的模型都会显示那个模型的思考档位和开关：Dimcode 所有模型共用一份档位
（#2568），Devin 的选择器缺少所选模型支持的档位。现在用户主动发起的刷新会在探测会话里用
`session/set_config_option` 依次切到每个模型，把每个模型自己的回答存入 machine Flock 行，并在
刷新进度里逐个显示模型名。新建会话页、Role 编辑器和 CLI/MCP 校验都按所选模型从这些行组合
选项。运行中的会话不做额外探测。只用单元测试和组件测试验证过，没有用真实适配器端到端运行；
E2EE 远程机器的刷新行为不变。

## 问题

- `['acpCapability', configId]` 保存一份 `session/new` 快照。探测和每个新建会话都会覆盖它，
  所以它描述哪个模型取决于上一个会话。
- 按模型的数据只来自适配器声明（Claude 和 Codex 的 `_meta.lody.modelCapabilities`，Grok 的
  `modelReasoningEfforts`），且只覆盖档位和 Fast。见
  [逐模型能力行](../../implemented/architecture/2026-09-29-per-model-acp-capability-row.zh.md)。
- ACP 的 `set_config_option` 会返回新模型的完整选项列表，所以一个探测进程就能回答所有模型。

## 决定

1. **存储。** 同一 Agent 的大多数模型共用同一份列表，所以每种不同的列表只存一次：
   `['acpModelConfigOptionsShape', configId, shapeId]` 保存 `{ version: 1, configOptions }`（Agent
   给出的列表，不含模型选择器），`['acpModelConfigOptions', configId, modelId]` 保存
   `{ version: 1, sourceVersion, shape }`。`writeAcpModelConfigOptionsToFlock` 在一次提交里写入一个
   配置的所有回答：内容相同就复用已有列表（列表 id 是哈希，复用前会比对内容）；只有当前值不同的
   模型保留原指针；没有模型引用的列表会被删除。`MachineDocument.updateAcpCapabilities` 在每次探测
   和新建会话时用快照自己的模型调用它，并带上刷新读到的每个模型
   （`AcpCapabilityWriteOptions.modelConfigOptions`）。112 个模型、5 种档位组合时约占 19 KB，
   每个模型存一整份则约 130～150 KB。
2. **读取模型。** 带 `readModelOptions: true` 的刷新请求（通过 `acpModelOptionsRead` v1 机器能力
   协商，因为旧 daemon 严格解析请求）会在 `session/new` 之后运行 `readEveryModelConfigOptions`：
   依次切到每个模型，只有当模型选择器正是该模型时才保留回答；切换被拒绝的模型跳过；某次切换
   在 `ACP_MODEL_OPTIONS_SWITCH_TIMEOUT_MS`（60 秒）内没有回答就停止，并保留已读到的结果。没有
   总时长上限：用户在看进度。daemon 只对内置 Agent 读取模型。
3. **谁会读取模型。** 只有 `useRefreshMachineAcpCapabilities` 设置这个标记：设置页刷新、Agent 配置
   对话框的探测、Test 和 Retry，以及引导页的对话框。启动时刷新、登录后验证、Provider 设置流程和
   CLI 命令保持原样。
4. **进度。** 每个模型作为一条 `machine/acp-binary-progress` 帧上报，状态为
   `reading-model-options`，并带 `configId`、`modelId`、`modelName`、`modelIndex`、`modelCount`，
   因此沿用现有的本地 IPC 和 Machine RPC 进度通道。渲染端从不把这些帧存为运行时安装状态，只有
   发起刷新的界面显示它们（「正在读取 DeepSeek Flash 的选项（2/40）」）。
5. **组合。** `resolveAcpConfigOptionsForModel` 对快照自己的模型或没有记录的模型保留快照
   （`snapshot` / `borrowed`），否则返回快照的模型选择器加上该模型记录的选项（`observed`）。档位和
   Fast 仍以声明优先。其他 `sourceVersion` 的记录仍会使用，直到下一次回答覆盖它。UI 选择器、
   Role 编辑器和 CLI/MCP 校验（`getAcpModelEffortChoices`、`getAcpModelFastSupport`、
   `withAcpConfigOptionsForModel`）都使用组合后的列表；没有记录时行为不变。

## 备选方案

- **运行中的会话每次切模型都探测，或给新建会话页常驻一个问询会话**：评审本设计后放弃；它们
  增加进程生命周期和每次切换的请求，而一次用户请求的刷新就能覆盖所有模型。
- **把选项列表存在 SessionDoc**：#343 讨论中已否决；草稿和新建会话页没有 SessionDoc，且列表是
  机器能力。
- **新增一种进度消息类型**：每条通道（TS 和 CJS 的本地 IPC 校验、Machine RPC、加密交互 owner）
  都按类型过滤进度帧；在现有帧上加一个状态就能复用全部通道。
- **每个模型存一整份列表**：更简单，但权限、Plan、Fast 这些选项每个模型都重复一遍，大目录下体积约是
  现在的七倍。
- **每个模型只存与快照不同的部分**：更小，但组合规则必须知道该模型去掉了哪些选项。

## 限制

- E2EE 远程机器暂不读取模型：其交互会话最多存活 300 秒，被中止的探测不写入任何结果。
- 渲染端和 Machine RPC 客户端仍保留原有的刷新总兜底时长
  （`ACP_CAPABILITIES_REFRESH_CLIENT_BACKSTOP_MS`）；即使兜底到期，daemon 仍会完成并写入记录。
- 只有内置 Agent 读取模型。Registry 和自定义 Agent 的刷新保持原样：它们的切换可能在会话之外
  持久化（registry Cursor 会改写其全局默认模型，#343）。
- Lody 之外的权益变化要到下一次刷新才能看到。已删除配置或模型的行不会清理。旧客户端忽略新行。
- #1215 的主要拒绝问题在 `main` 上已不再复现；物化阶段的确定性错误仍会重试到 `TARGET_TIMEOUT`。

## 验证

- `packages/shared/tests/acp-run-config.test.ts`：组合，以及按观察到的目标模型校验档位和 Fast。
- `packages/shared/tests/machine-flock.test.ts`：100 个模型、3 种列表只存 3 份；仅当前值变化不写；
  无人引用的列表被删除；无论来源版本都附加记录。
- `packages/shared/tests/machine-protocol-capabilities.test.ts` 和 `local-session-control.test.ts`：
  对旧 daemon 不发送该标记；两套本地校验都接受请求和进度帧。
- `apps/cli/src/agent/acp-capabilities.test.ts`：读取每个模型，跳过被拒绝的切换，在无回答的切换处
  停止，未请求时不切换。
- `apps/cli/src/lib/loro/machine-document-capabilities.test.ts`：按模型写入，只按结构判断变化。
- `apps/cli/src/commands/session.test.ts`：#1215 的形态按观察到的列表校验。
- `packages/components/tests/acp-selector-options.test.ts`（#2568）和
  `provider-row-reauthentication.test.tsx`（进度文案）。
- 未验证：真实适配器的切换耗时和回答，以及运行中桌面应用里的界面。
