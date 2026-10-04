# 按目标模型验证冻结的 Session 创建选项

Status: implemented
Translation: current

[English](2026-10-02-session-create-target-model-validation.md)

## 摘要

Session 创建接受了非探测模型的语义推理配置，却在持久化执行时拒绝相同的具体选项。探测快照的推理档位属于另一模型，导致 Session 无法创建，直到 Operation 超时。创建验证现在从已保存的模型和选项重新计算目标模型的推理与 Fast 豁免，沿用 chat 的验证规则。既有冻结 Operation 与 Role 创建无需迁移即可受益；未知目标能力仍交运行时验证。

## 决定

Issue [#1215](https://github.com/LodyAI/Lody/issues/1215) 指出了语义接受与具体重放的差异。`resolveEffectiveSessionCreateDispatchConfig` 在快照选项验证前，将语义解析器的已验证 ID 与 `validateModelDependentTurnConfigOptionValues` 的结果合并。顶层模型优先于模型选项，与实际分发一致。目标模型声明的限制以及无关选项的验证仍保持。

与 [#956](https://github.com/LodyAI/Lody/issues/956) 整合时保留既有可选的冻结验证 ID，维持传输与存储兼容；即使没有保存这些 ID，仍重新计算模型相关验证。因此旧 Operation 和具体 Role 配置无需新增 schema 字段或迁移即可受益。外围的确定性验证错误分类保持不变，不支持的目标配置仍返回 `COMMAND_REJECTED`，不重试到超时。本修改恢复已有的模型相关验证约定，不改变 Spec 意图；composer 菜单保持不变。

合入 main 后保留显式 raw mode/model 覆盖继承标量选择器的优先级，以及旧式 Plan 冲突拒绝。目标模型校验仍在合并继承配置之前执行。

## 验证

Session command 原有测试套件以合成机器能力行调用真实 `prepareSessionInput`，覆盖语义创建后 JSON 冻结的具体重放、Role 风格模型选项、探测模型或目标声明不支持的档位拒绝，以及未知选项拒绝。未运行真实 Devin ACP 或 daemon 重试调度；已覆盖共用的准备边界。
