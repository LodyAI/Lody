# 在缺少探测声明时规范化历史 Schedule Fast 值

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1911

[English](2026-10-26-schedule-fast-compatibility.md)

## 摘要

当缓存探测描述的是另一个模型且没有 Fast 时，历史 Schedule 布尔字符串会保持字符串类型，随后在普通 Session 验证中失败。Schedule 规范化现在会在探测结果未包含该字段时识别共享语义 ID `fast` 和 `fast-mode`，同时保留明确声明的 select 和无关字符串选项。只转换精确的 `"true"` 与 `"false"`，且不修改已保存定义，以维持其授权指纹有效。

## 决策

Schedule v2 保留 ACP 字符串和布尔值。原有投影只会转换缓存探测声明为 boolean 的历史字面值；Fast 的 ID 是跨模型稳定的语义控制，而能力探测只描述被探测模型的控件，因此这不足以处理 Fast。复用现有 ID 契约 `isAcpFastModeConfigId`：声明为 boolean 的选项照常转换；探测中缺失的 Fast ID 也转换。若同一个 Fast ID 明确声明为 select，则保留字符串。其他 select 与未知选项字符串均不改变。

此方案不会把所有看起来像布尔值的字符串都强制转换，不会从显示名称推断 Fast，也不会据此宣称目标模型支持 Fast。目标模型验证器和 Agent 仍负责判断支持情况。它也不会重写 Schedule 定义或账本，指纹仍覆盖已授权的持久化定义。

## 证据与验证

Issue #1732 的合成场景以 `opus` 为目标模型，探测结果不含 Fast，保存值为 `fast: "false"`。修复前，生产 `prepareSessionInput` 回归测试因 `Config option "fast" expects a boolean or on/off value.` 失败；修复后通过。覆盖还检查两个 Fast 别名及 true/false、ID 为 `fast` 的显式 select、无关 select 字符串，以及原有的指纹不变行为。

附在 [PR #1911](https://github.com/LodyAI/Lody/pull/1911) 的修复前后终端录屏使用相同合成输入和测试命令，分别对应基线 `91fa467a205c` 与修复提交。Fixture 不会连接 Provider，也不会更改已保存的 Schedule。

将所有精确布尔字符串都转换的简单方案会破坏普通 select 值。要求探测必须声明 boolean 则仍会复现 Issue。最终保留的 ID 特例仅限两个 Fast 语义 ID，且不绕过目标模型验证。
