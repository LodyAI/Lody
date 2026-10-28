# 保持 onboarding 预览的提示建议订阅隔离

Status: implemented
Translation: current

[English](2026-10-28-onboarding-tour-prompt-subscription.md)

## 摘要

桌面 onboarding 的产品预览挂载 composer 时崩溃，六个 smoke 场景均无法进入 Agent 配置。composer 现在会读取提示建议，但 tour 的隔离 runtime 缺少该订阅方法。fixture 现返回无建议，并提供不执行操作的清理函数。预览继续与真实工作区订阅及持久化隔离。

## 证据与决策

- [PR #1998](https://github.com/LodyAI/Lody/pull/1998) 的[失败任务](https://github.com/LodyAI/Lody/actions/runs/40626372854/job/122612190080)构建成功，随后六个场景均在等待 Agent 配置标题时失败。截图与 trace 显示 `subscribePromptSuggestion is not a function`。相关 fixture 和 hook 在 base `574cfb00a` 与 PR head `91d320cfa` 之间没有改动；缺少该方法并非聊天目录清理改动引入。
- [TourApp](../../../../packages/components/src/components/onboarding/tour/tour-app.tsx) 使用[自己的 runtime](../../../../packages/components/src/components/onboarding/tour/tour-fixtures.ts) 挂载真实 composer。[提示建议 composer 集成](../feature/2026-10-27-prompt-suggestion-composer-ui.zh.md)通过普通 hook 调用必需的订阅。应在 fixture 中提供空值读取契约，不弱化生产 hook 或 E2E 标题断言。
- [现有隔离测试](../../../../packages/components/tests/tour-app-cloud-isolation.test.tsx)现在在复用 composer 的边界执行真实提示建议 hook，断言空建议与合成机器/项目可见性数据一起渲染。

## 验证与限制

修复 fixture 前，扩展测试与重新构建的 Electron onboarding 场景均复现相同的缺失方法错误。修复后，四个定向 fixture/hook 套件的六项测试通过。重新构建的 OSS 桌面 smoke 保持原有 E2E 断言，六个场景、42 步全部通过。该订阅有意不产生实时建议；本次修复不代表已验证外部 Agent 的建议交付。
