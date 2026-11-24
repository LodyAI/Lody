# 按模型隔离推理与速度配置并按需确认同机 Machine Flock 读取

Status: implemented
Translation: current
Language: [English](2026-11-23-per-model-session-config-and-same-replica-flock-authority.md)

## 摘要

三个相互耦合的假设导致了同机创建子会话失败及跨模型菜单污染：同副本（`sameReplica`）Machine Flock
读取跳过远端同步却硬编码返回 `confirmed: false`；Role 编辑与会话默认配置按 Provider 扁平存储
`thought_level` 与 `fast-mode`（`normal` / `fast` / `ultrafast`），而非按模型隔离；自定义与
Registry ACP Agent 在未主动探测所有模型时从不记录按模型选项列表。现在，同副本 `acpCapability`
读取直接信任单写者同机 Daemon（`confirmed: true`），仅在本地缺失时做远端同步；多写者
`agentConfig` 与 `localProject` 读取优先查本地副本，仅在未命中时执行远端确认。活跃 ACP 会话切换
模型或收到 `config_option_update` 时会后台被动记录该模型的选项列表到 `mf:<machineId>`；Role 保存不再
自动注入借用的模型相关默认值；会话默认配置与输入区草稿均按 `modelId` 独立存储推理档位与速度档位。

## 问题

- **同机能力快照被视为未确认**：当 `daemonTarget.sameReplica` 为真时，`session.ts` 为省去云端往返
  跳过了 `syncFlockDocOrThrow`，却固定返回 `confirmed: false`。一旦同机 Role 携带目标模型不支持的
  `thought_level`，`validateSessionCreateOptions` 会把同机 Daemon 自己写入的能力快照当成未同步旧缓存，
  返回可重试的 `SYNC_UNAVAILABLE` 而非确定性的 `COMMAND_REJECTED`。
- **Role 与菜单借用其他模型的选项**：自定义与 Registry ACP Agent（如 Antigravity）不参与全模型主动探测
  （见[观测模型选项设计](../../proposed/architecture/2026-11-11-observed-model-config-options.zh.md)）。
  当 `session/new` 在思考模型（如 `claude-opus-4-6-thinking`）上完成探测后，切换到不支持思考的模型
  （如 `gemini-orchestrator`）会借用 `thought_level: 'high'`。`applyAgentRoleRunConfigDefaults` 与
  `prepareAgentRoleTargetForSave` 都会把该借用默认值写入 `role.runConfig.configOptionValues`；同时
  `normalizeReasoningEffortSelectors` 在 `modelReasoningEfforts[modelId]` 为 `[]` 时仍保留了快照中的
  `thought_level` 选择器。
- **推理与速度档位按 Provider 扁平持久化**：`AgentSessionDefaults`、`AcpSessionConfigPreferences` 与
  `SessionRunConfigDraft` 将 `thought_level` 和 `fast-mode` 混存在单个扁平 `configOptionValues` 中，
  在一个模型上修改推理强度或 Codex 速度（`off` / `fast` / `ultrafast`，见[按模型能力行](2026-09-29-per-model-acp-capability-row.zh.md)）
  会污染同一 Provider 下的其他模型。此外，`speedTiers` 上线前缓存的 Codex `1.12.0` 快照在二进制未升级时
  一直停留在布尔 `fastMode`，移动端输入栏也缺少三档速度循环切换。

## 决策

1. **按写者归属划分同副本 Machine Flock 权威性。**
   - `mf:<machineId>` 中的 `acpCapability` 由同机 Daemon（`MachineDocument`）唯一写入。`sameReplica`
     命中本地快照时，`readAgentAcpCapabilitySnapshot` 立即返回 `confirmed: true`（0 ms 远端等待），仅在
     本地缺失时调用 `confirmSameReplicaMachineFlockOnMiss`。
   - `agentConfig` 与 `localProject` 可由桌面端或移动端写入。`sameReplica` 读取优先查询本地副本（命中即
     `confirmed: true`），仅在本地未命中时调用 `confirmSameReplicaMachineFlockOnMiss`
     （`syncFlockDocOrThrow(..., { requireRemoteConfirmation: true })`）：同步成功返回 `confirmed: true`
     以确定性拒绝无效 ID，同步失败返回 `confirmed: false` 并保留可重试的 `SYNC_UNAVAILABLE`。
2. **会话运行期被动观测模型选项与 Role 自动收敛。**
   - 活跃 ACP 会话切换模型（`applyAcpModeAndModel`）或收到 `config_option_update` 通知
     （`message-handler.ts`）时，通过 `WorkspaceDocument.recordObservedAcpModelConfigOptions` 在后台将当前
     模型的非模型 `configOptions` 写入 `mf:<machineId>`（`markMachineFlockDirty`），复用
     `writeAcpModelConfigOptionsToFlock` 的结构去重且不阻塞消息主路径。
   - 当 `modelReasoningEfforts[selectedModelId]` 显式为 `[]` 时，`normalizeReasoningEffortSelectors` 移除
     `thought_level` 下拉项。
   - 当 `modelConfigOptionsSource === 'borrowed'` 时，`applyAgentRoleRunConfigDefaults` 与
     `prepareAgentRoleTargetForSave` 跳过未显式设置的模型相关选项（`thought_level`、`fast-mode`、`speed`）。
   - 共享纯函数 `reconcileAgentRoleRunConfig` 根据 `observedModelConfigOptions`、`declaredModelControls`
     或 `modelReasoningEfforts`，在工作区启动维护（见[自动收敛规范](../../../../specs/agent-role-schema-reconciliation.zh.md)）
     及 `--agent-role` / MCP `agentRoleId` 创建会话校验前自动剔除目标模型已证实不支持的非权限选项。
3. **按模型隔离推理强度与多档速度状态。**
   - `AgentSessionDefaults` 与 `AcpSessionConfigPreferences` 新增可选
     `modelConfigOptionValues?: Record<string, Record<string, AcpConfigOptionValue>>`，
     `AcpSessionUserConfigEdits` / `SessionRunConfigDraft` 新增 `modelConfigOptions`。模型相关选项按
     `modelId`（兼容独立 `modelId` 与通用 `configOptionValues.model`）持久化和派生，切模型时自动将旧扁平
     字段迁移到切出模型名下，同时保持 `useAcpSessionConfigSelectionState` 的纯派生约束。
   - 内置 Codex 能力 `sourceVersion` 追加 `speed-tiers:1` 后缀以自动刷新旧布尔缓存；UI、CLI 与 MCP
     （`speedTiers` / `speedTier`）统一将 `'normal'` 和 `'standard'` 归一化为 `'off'` / `false`；
     `MobileFastModeToggle` 支持 `off` -> `fast` -> `ultrafast` -> `off` 三档循环切换。

## 备选方案

- **在 `sameReplica` 读取时一律执行 `syncFlockDocOrThrow`**：虽能解决缺失确认，但会让每次同机子会话创建
  重新承担云端同步延迟，并在离线但本地已有缓存时破坏同机可用性。
- **对自定义与 Registry ACP Agent 主动逐模型探测**：与[观测模型选项设计](../../proposed/architecture/2026-11-11-observed-model-config-options.zh.md)
  相同被否决——第三方 Adapter 在 `set_config_option` 时可能改写全局默认状态或拥有上百个模型。借由真实会话
  的模型切换被动记录无需额外进程或合成请求。
- **用 `useEffect` 在切模型时同步覆写选择状态**：违反输入区纯派生不变量（#185），在候选模型反向驱动目录构建
  时易引发渲染震荡。

## 限制

- 在某台机器上首次使用自定义或 Registry Agent 的某个非默认模型之前，该模型的选项来源仍为 `borrowed`：
  输入区会继续展示暂定控件以免阻塞合法选择，而 Role 编辑器不会将借用默认值自动固化进 Role。

## 验证

- `apps/cli/src/commands/session.test.ts`、`apps/cli/src/mcp/daemon-session-tools.test.ts` 与
  `apps/cli/src/lib/loro/machine-document-capabilities.test.ts`：覆盖同副本能力权威性、未命中按需远端确认、
  Role 创建时按目标模型收敛、被动观测落盘与 MCP `speedTier` / `speedTiers`。
- `packages/shared/tests/acp-run-config.test.ts` 与 `packages/shared/tests/agent-role.test.ts`：覆盖
  `'normal'` / `'standard'` 速度别名归一化与 `reconcileAgentRoleRunConfig`。
- `packages/components/tests/acp-selector-options.test.ts`、
  `acp-session-config-selection.test.ts`、`session-config-selection-oscillation.test.tsx`、
  `use-chat-landing-defaults.test.tsx`、`mobile-run-config-sheet.test.tsx`、
  `agent-role-form.test.ts` 与 `use-agent-role-schema-reconciliation.test.tsx`。
