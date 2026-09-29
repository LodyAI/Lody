# 最后设置权限，并在发送前核对

Status: implemented
Translation: current
Language: [English](2026-09-29-run-config-permission-last.md)

## 摘要

Lody 以前先设置 turn 的权限模式，再切换模型，并把请求的模式当作结果记录下来。
Claude 切换模型时会重建权限模式；如果新模型不支持当前模式，就回退到 `default`。
所以用户请求的 `plan` 可能变成更宽的 `default`，而且没有人看得到。
现在 applier 先切模型，再设置普通选项，最后设置 Plan 和权限模式；在发送 prompt 之前，
用 agent 针对这次设置自己报告的状态来核对。受限请求无法确认，或者结果比请求更宽时，
这一轮会停下来，并给出请求值和实际值。这是按模型解析控件工作的第一步，先于任何放宽校验的改动上线。

## 问题

- **顺序**：`applyAcpSessionRunConfig` 先调用 `setSessionMode`，再调用 `unstable_setSessionModel`，
  模型切换可能会重建或降级刚设置好的模式。
- **把请求值当作结果**：模式设置成功后，即使 agent 报告的是另一个模式，也会把请求的模式写进 runtime 快照。
- **警告被隐藏**：Claude 和 Codex 的 Plan 请求被拒绝时，不会显示为可见警告。
- **没有来源信息**：`AgentClient` 不记录设置结果是否来自 agent。`setSessionMode` 没有返回值；
  异步的 `config_option_update` 通知会直接替换选项列表，无法和这次设置自己的响应区分开。

## 决定

- **顺序**：模型 → 普通选项 → Plan（Core `plan_mode` 或旧的 `collaboration_mode`）→ `_permission` 类选项 → 权限模式。
- **意图**：`resolveSessionSafetyIntent` 遍历截至当前 turn 的历史目录行，分别返回最近一次的模式和 Plan。
  daemon 读取的是目录行，不加载 turn 正文。如果本 turn 切换了模型，或者 agent 当前报告的状态不是继承的设置，
  就重新发送该设置。
- **证据**：
  - `setSessionMode` 返回三种结果之一：`config-response`（agent 为这次请求返回的列表）、
    `set-mode-ack`（真正发出并得到回应的 `session/set_mode`），或 `none`（空回执，或根本没有发送）。
  - agent 每报告一次列表、每发一次 `current_mode_update`，`AgentClient` 都会递增报告代次。
    设置之后的报告只能否定这次设置，不能确认它。
- **判定**：内置模式的顺序在 `acp-permission-order.ts` 中定义，Claude 的 `plan` 和 Codex 的 `read-only` 属于受限模式。
  核对规则见[安全 Spec](../../../../specs/acp-run-config-safety.zh.md)：
  - 受限请求如果未确认、设置失败、不可比较或被否定，这一轮停止；
  - 任何请求如果确认结果更宽，这一轮停止；
  - 其他不一致只显示可见警告。

  被停止的 turn 以 `turn_pre_prompt_failed` 呈现，消息中写明请求值和实际值，所以旧客户端不需要新的错误码。
- **runtime 快照**：`set-mode-ack` 只在 agent 没有报告任何模式状态时才填入模式，不会覆盖已报告的模式。

## 备选方案

- **用 UI 的显示分类作为顺序**：`classifyPermissionModeFace` 只决定显示哪个图标；`default` 和未知模式都对应 `hidden`。
- **保持顺序，只是不再把请求值当作结果**：放宽会变得可见，但仍然会发生。
- **一次性「接受更宽权限」的流程**（PR #333）：暂缓。现在停止并给出清楚的消息已经足够，Spec 中将其列为待决问题。

## 验证

- `acp-session-config-applier.test.ts` 驱动一个有状态的假 agent。它会在切换模型时重建模式，
  可以返回完整列表、裸 ack 或空回执，也可以自行发出报告。逐一移除以下四条规则，每次都有对应测试失败：
  - 把空回执当作确认；
  - 忽略设置之后的报告；
  - 从不重新发送继承的模式；
  - 允许非受限请求得到更宽的结果。

  最后一条最初被静默通过，因此专门补了一个测试。
- shared 测试覆盖按字段解析意图，以及模式顺序。
- `tests/session-execution-service.test.ts` 现在在模型这一步（第一个设置）卡住，仍然能证明停止之后不会再发送任何设置。
- 尚未验证：真实 Claude 和 Codex 适配器的端到端流程；按模型控件提案中列出了这些 e2e 流程。
