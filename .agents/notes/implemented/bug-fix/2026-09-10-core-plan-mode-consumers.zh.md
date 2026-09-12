# 让 Plan 消费者与 ACP Core 对齐

Status: implemented
Translation: current

[English](2026-09-10-core-plan-mode-consumers.md)

## 摘要

Codex 的 adapter 已经广播 Core 的布尔字段 `plan_mode`，而 Lody 仍只识别更旧的
`collaboration_mode` 下拉项。该选项能通过解析，但被归类为普通布尔值，桌面端运行菜单因此不予展示。
能力发现、静态默认值、开关与 plan 决策辅助逻辑现在在 Codex、Grok、Kimi 与 DeepSeek Harness 上都
理解 Core 契约。为更旧的 agent 保留旧版下拉支持；独立的计划能力从不改变权限策略。

## 决策与证据

字段身份与选项工厂由 Core 拥有。共享的静态内置能力使用该工厂，而不是复制其 schema。语义分发在
两代同时被广播时优先选择 Core 布尔值，仅支持旧版的 agent 继续收到 `default`/`plan`。运行时快照
仍然权威；不会重写任何已存储的历史或能力缓存。

Grok 与 Kimi 的静态选择器也需要迁移：Grok 现在暴露 Plan 以及 Ask/Always Approve，与其 wrapper
一致；Kimi 暴露带 Default/Auto/YOLO 的 `permission_mode` 以及独立的 Plan 布尔值。它们旧版的 ACP
mode 仍作为协议元数据可用，但不再用于构建现代权限选择器。Claude 保留其既有的、基于权限的 Plan
行为。DeepSeek 的内置 profile 包含 `dsh-plan-mode`，因此 preflight 可能提供 Plan；若服务缺席，
实际的会话能力快照仍然权威。跨 provider 的回归同时覆盖静态条目与运行时缺省。

只改选择器分类会让 UI 开关把字符串发给一个布尔字段。因此本次修复还包含取值解析，以及在进入实现
阶段前关闭计划的辅助逻辑。shared 与组件回归套件覆盖 Core 能力发现、分发、选择器投影、切换与权限
值的保留，并保留既有的旧版用例。

执行 turn 的 override 也处理布尔型 Plan 快照，包括一个运行时当前值为 true 的未初始化草稿。它为新的
执行 turn 冻结 `plan_mode: false`，且不编辑原草稿或权限模式。

## 验证

shared 能力与组件的选择器/UI/plan 决策/执行 turn 套件均通过。shared 与组件的 TypeScript 检查通过。
这些检查作用于合成契约与已渲染控件；本次分支改动没有重建或重启运行中的桌面端/daemon。

创建 PR 之前 `pnpm format` 完成；无关格式化改动已排除。完整的 `pnpm check` 在准备 Claude adapter
阶段中止，因为该 worktree 缺少其依赖（`@tsconfig/node22`、ACP 与 Anthropic SDK），未能进入仓库级
测试套件。初始化固定 submodule 之后，文档检查与公开边界检查通过。

跨 provider 的后续改动在内置能力、run-config、选择器、UI 与执行 turn 套件中通过了 112 个定向测试，
以及 shared 的 TypeScript 检查。它保留了 Claude 既有的、基于权限的计划行为。PR：
[#566](https://github.com/LodyAI/Lody/pull/566)。

参见[输入框运行配置](../../../docs/sessions-run-config.md)与
[缓存兼容性意图](../../../../specs/acp-capability-cache-compatibility.md)。本次修复实现的是既有的
Core 契约，而非改变其意图。
