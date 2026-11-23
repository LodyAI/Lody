# Kimi 计划提交接入共享计划卡片

Status: implemented
Translation: current

[English](2026-09-21-kimi-plan-cards.md)

## 摘要

Kimi 原先只在工具内容里提供计划审阅正文，并把计划工具归类为普通工具，
导致 Lody 无法可靠地使用专用计划展示界面。适配器现在向声明支持 ACP 实验性
计划能力的客户端发送 Markdown 计划事件，并将计划提交工具标为模式切换。
原有审批正文保留为兼容路径；批准或退出 Plan 后，已提交的文档仍留在对话历史中。

## 边界与取舍

此问题独立于[计划文件缺失修复](2026-09-20-kimi-plan-file-errors.zh.md)。
Plan 布尔开关及审批决策不变。`TodoList` 继续使用稳定的 ACP 清单事件；
计划文档使用实验性的 `plan_update`，由 `clientCapabilities.plan` 协商。
无需新增 Lody 私有通知或供应商专属渲染器：Lody 已声明该能力，将 Markdown
保存为 `proposed_plan`，并在共享计划面板中展示，避免重复渲染审批内的正文。

仅 `ExitPlanMode` 使用 `switch_mode`：Lody 将该类型作为计划决策界面，
如果进入 Plan 也使用该分类，会把进入模式的输出误当成计划正文。

适配器在工具启动时转换已解析的 `plan_review` 展示数据，覆盖手动和自动审批。
每次提交的 ID 按轮次和工具调用区分；分叉元数据仍采用用户可见的分叉位置，
不使用计划 ID。只展示已提交的快照，不追踪每次文件编辑。退出 Plan 不代表
删除对话里的文档。原生 ACP 上下文回放不能重建过去的计划审阅展示，本次未
承诺补齐该能力；Lody 则会将收到的卡片保留在自己的历史中。

## 验证与交付

通过真实引擎、脚本化模型与内存 ACP 连接验证 Markdown、能力兼容、模式切换
分类，以及批准、修改、拒绝和自动批准。缺失事件的回归测试在修复前失败。
Lody 历史测试验证正文替换，以及工具完成后卡片仍保留。本次测试不代表完成了
界面截图验收或生产运行时验证。仍需发布独立构建并带校验和的 Kimi 运行时，
更新 managed-runtime 清单，已安装客户端才能获得修复。

适配器 PR：[Kimi #14](https://github.com/LodyAI/acp-extension-kimi/pull/14)。
消费端版本与回归测试：[Lody #870](https://github.com/LodyAI/Lody/pull/870)。
先合并适配器；这两个 PR 均不发布生产运行时。
