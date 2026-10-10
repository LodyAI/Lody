# 读取启动证据之前，等待应用文档就绪

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1398

[English](2026-10-10-e2e-initial-renderer-navigation.md)

## 摘要

两个桌面 smoke 场景在执行任何步骤之前就于启动钩子失败，因为读取启动性能时，
首次导航销毁了正在求值的 renderer 上下文。现在 harness 先等待构建出的应用入口
文档完成 DOMContentLoaded，再收集启动证据。此做法保留早期控制台及 trace 捕获，
沿用既有启动期限，不重试失败场景。

## 证据与决定

[失败任务的完整日志](https://github.com/LodyAI/Lody/actions/runs/38048553136/job/114202910380)
显示安装、套件检查、桌面构建成功，随后 ONBOARDING-001 与 SESSION-005 在
`readBootProfile()` 失败；其余四个 smoke 场景通过。失败产物有 main-window-opened
诊断，却没有启动标记。renderer 加载失败出现在启动异常之后的清理阶段，不能
据此确认此前存在产品故障。

`firstWindow()` 观察窗口创建，不保证异步 `loadFile()` 已提交。初始 `about:blank`
文档的 readyState 也可能已经 complete。首次 renderer 求值前，先等待准确的构建
`index.html` URL（忽略路由 hash）及其 DOMContentLoaded 事件，控制台监听和 tracing
则在等待之前安装。sleep 或异常重试都不能证明正确的文档已经就绪。
[隐藏窗口策略](2026-09-12-desktop-e2e-window-visibility.zh.md)和真实 Electron/CLI
边界保持原有约定；产品行为和[查询恢复决定](../bug-fix/2026-10-10-cloud-query-server-recovery.zh.md)未改变。

## 验证

`pnpm --filter @lody/e2e check` 的 24 个场景绑定、类型检查及 49 个既有 harness/
工具测试通过。`pnpm e2e:build` 和完整 `pnpm e2e:smoke` 在 Linux 本地的独立
Xvfb display 中通过：六个场景、40 个步骤，包括 CI 中的两个失败场景。Xvfb
通过 display-fd 信号确认就绪，运行结束后关闭 display 和应用进程。修改文件
lint、格式检查及仓库文档检查也通过。macOS 验证仍由 CI 执行。

根 `pnpm check` 的类型检查和 lint 通过，但在未修改的 CLI 测试处退出：Roost
历史、原生 Git 凭据、cloudflared 和模拟器进程共六个套件的 18 个用例失败。
报告包括 30 秒超时、后续残留 mock 断言、子进程 fixture 启动失败，以及本地
Git wrapper 的 `context_unreadable` 诊断。递归测试停止之前，一个未修改的
mention-textarea 用例也触达五秒超时。这不代表完整套件通过；未修改无关测试
或超时设置。
