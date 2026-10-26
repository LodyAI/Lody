# 标题自动生成沿用 Provider 当前模型

Status: implemented
Translation: current

[English](2026-10-26-title-generation-provider-model.md)

## 摘要

通用 ACP 标题生成曾从目录最后一项推断模型，因此目录顺序可能在隔离标题会话中静默切换到 Amp Ultra 等更昂贵的模型。现在，除非用户保存了明确的标题模型，否则运行时将模型选择交给 Provider；现有 builtin Codex、权限和推理默认值保持不变。缺少模型能力时不会产生模型覆盖。共享行为测试通过；CLI 集成套件因当前嵌套 checkout 缺少隔离适配器子模块中的 Claude SDK 依赖而无法启动。

## 决策与证据

`computeTitleGenerationDefaults` 曾使用目录最后一项作为 `model` 值，即使 `currentValue` 指向另一模型。隔离标题生成器会通过 `applyTitleConfigOptions` 应用所有提供的值，设置对话框也会将推断默认值合并进已保存的标题配置，因此目录顺序被误当成了用户偏好。

通用 Provider 的推断默认值现在不包含模型。设置对话框因此没有推断模型可保存，而明确持久化的标题模型仍沿用现有应用路径。Builtin Codex 保留文档所述的 `gpt-5.6-luna` 默认值。权限和推理默认值不变，并继续独立于模型选择。缺少模型能力时，通用默认对象不包含模型键。

保留目录最后一项选择的方案被否决，因为 ACP 选项顺序没有表达偏好或费用的语义。此改动不会修改已经保存的显式选择，也不影响主会话模型。

确定性共享套件覆盖目录顺序与当前模型不一致、缺少模型能力、通用 Provider 行为和 builtin Codex 特例。CLI 测试还覆盖保留 Amp 当前模型及应用显式旧式模型选择。聚焦基线回放因结果包含 `model: "ultra"` 而失败；修复后同一场景通过，完整共享套件 19 项通过。CLI 套件已尝试运行，但当前 checkout 的隔离 Claude 适配器缺少嵌套 SDK manifest，导致测试收集前无法启动。

## 验证

- Shared：`vitest run packages/shared/tests/title-generation-defaults.test.ts` — 19 项通过。
- CLI：`vitest run src/agent/title-generator.test.ts` — 因缺少 `packages/acp-extension-claude/node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`，未能收集测试。
- Pull request：[#1909](https://github.com/LodyAI/Lody/pull/1909)，draft。
