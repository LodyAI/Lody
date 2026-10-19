# 等待引导页的最终操作入口

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1554

[English](2026-10-14-e2e-onboarding-final-action.md)

## 摘要

桌面 smoke 在进入引导流程时失败，因为测试要求点击已经消失的“跳过介绍”按钮。
真实本地 CLI 启动期间，介绍可能已自动结束，页面只保留“开始配置”入口。
共享 Page Object 现在直接等待这个稳定的最终操作。
产品行为、断言覆盖和超时设置不变，也没有增加重试或固定等待。

## 证据与决策

完整的 [Actions 日志](https://github.com/LodyAI/Lody/actions/runs/38506904691/job/115666416152)
显示依赖安装、套件检查和桌面构建成功，五个 smoke 场景通过，只有 WINDOW-001
在初始 Given 步骤失败。失败截图显示介绍最终屏和 Configure Lody 按钮，
trace 则显示查找 Skip intro 超时。介绍会自动经过三个阶段，因此 CLI 就绪
并不代表临时的跳过按钮仍存在。

移除 `OnboardingPage.openAgentConfiguration` 中作为前置条件的跳过点击。
无论介绍仍在播放还是已经结束，Playwright 都等待 Configure Lody，
之后保留原有标题断言来确认进入配置。这遵循
[应用就绪决策](2026-10-10-e2e-initial-renderer-navigation.zh.md)：
等待可观察状态，而非用重试掩盖失败。

## 验证

隔离链接已安装的 E2E 依赖后，`pnpm e2e:check` 通过全部 24 个场景绑定、
TypeScript 和测试工具检查。临时浏览器验证调用真实 Page Object，在合成的
已结束介绍页上复现旧代码失败；修复后，从已结束和显式推进的介绍状态都能
进入配置标题。这项定向验证不是完整桌面 E2E。

当前检出缺少产品依赖，`pnpm e2e:build`、根目录 `pnpm check` 和 `pnpm format`
无法完成。缺少构建后的主进程入口使桌面 smoke 无法启动。
修改文件的 Oxfmt 和 `git diff --check` 通过，macOS 桌面验证仍需由 CI 完成。
未修改用户配置或运行中的 Lody 实例。
