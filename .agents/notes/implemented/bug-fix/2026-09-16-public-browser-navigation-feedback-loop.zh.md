# 公共浏览器的导航状态不能变成新的导航意图

Status: implemented
Translation: current

[English](2026-09-16-public-browser-navigation-feedback-loop.md)

## 摘要

桌面公共浏览器可能会把 native 回传的 URL 观察值重新交给 renderer，并把它当成新的地址栏请求。通过真实 Electron/Playwright 诊断，重定向、历史前进后退、同文档 hash 变化和 `window.open` 都复现了额外导航；`baidu.com` 只是其中一个明显案例，因为它会跳到 `www.baidu.com/`。目前证据指向 native 状态流与 renderer 导航请求身份之间的所有权/时序错误，而不是 connect reset。`www.baidu.com` 直达也会产生多次 loading state，但当前样本没有产生第二次 `navigate`；后续增加一个覆盖真实 renderer 面板边界的确定性 fixture 会提升覆盖率，但不是采用本次 controller 修复的前置条件。

## 证据

诊断矩阵通过现有 E2E harness 启动构建后的 OSS Electron 桌面端，实际经过 preload、IPC、`WebContentsView` 和主进程服务；同时在 renderer 中临时模拟面板的 URL 观察回写。由于 E2E 套件禁止真实网络场景，该诊断代码没有落库。

- `baidu.com` 和 `https://baidu.com` 会规范化成 `https://baidu.com/`，随后收到 `https://www.baidu.com/`；当 renderer 观察路径回写这个 URL 时，会触发第二次 `publicBrowser.navigate` 和第二次主 frame 导航。第一次导航随后以 `-3`（`ERR_ABORTED`）报告失败，然后第二次导航提交。
- `http://baidu.com` 经过 HTTPS/www 重定向后也出现同样的额外导航。
- `www.baidu.com` 和 `www.baidu.com/` 都直接规范化为 `https://www.baidu.com/`；本矩阵没有观察到第二次 URL 驱动的导航，但在 `ready` 之前确实出现了 5 次 loading state。
- 公共浏览器的 Back 和 Forward 都产生了观察 URL 变化，并在没有新地址栏请求的情况下再次发送给 `navigate`。
- 同文档 hash 变化和页面触发的 `window.open` 也都从观察路径产生了第二次 `navigate`。
- Reload、加载中 Stop、快速替换地址、隐藏/显示/重新绑定，在本诊断矩阵中没有产生额外的 URL 驱动导航。
- 所有测试的 IPC 操作都返回 `ok: true`。反馈环样本中唯一的失败是被第二次加载取代的主 frame 加载取消（`-3`）；没有观察到 connection reset（`-101`）或公共浏览器 error state。这不能排除特定用户环境中的网络失败，但目前没有证据表明 connect reset 是主要触发因素。

相关的所有权边界位于
[`PublicBrowserSurface`](../../../../packages/components/src/components/sessions/public-browser-surface.tsx)：这里按 request ID 加 URL 去重；以及
[`SessionBrowserPanel`](../../../../packages/components/src/components/sessions/session-browser-panel.tsx)：这里把 native state 的 URL 写入当前地址。native 服务则在
[`PublicBrowserService`](../../../../apps/electron/src/main/services/public-browser-service.ts)
中发出重定向和同文档导航观察值。

## 已实现方向

renderer 现在把显式公共导航保存为带 session 级单调 ID 的 `{ id, url }`，并将这个 request 传给 `PublicBrowserSurface`。native URL 观察仍然会更新地址和历史，但不能替换待执行的显式 request，因此重定向、同文档导航和历史移动不会重新进入 `loadURL`。surface 只有在已经 ready、即将派发 request 时才报告它已消费；controller 随后清除匹配的 request。这样 surface 在 ready 前重挂载时会保留真实的未派发意图，而已经派发的 request 不会被新的 surface 实例重放。ID 不从当前 pending request 推导，因此消费 request 后重试相同 URL 仍会进入 native navigation。surface 同时 memoize Electron bridge，避免普通状态 render 反复 teardown/rebuild native view 的 visibility/layout effect。页面打开的目标继续由 native 所有，不会被重新归类为地址栏请求。

## 外部研究

Electron 当前的 [`webContents` 文档](https://www.electronjs.org/docs/latest/api/web-contents)
区分了文档导航事件和页面内导航：`did-navigate` 只对应主 frame，而
`did-navigate-in-page` 报告不会重新加载文档的 URL 变化。文档还提供了
`did-start-navigation.details.isSameDocument` 和 `contents.isLoadingMainFrame()`
这样的主 frame 感知信号。Electron 官方 issue
[#30479](https://github.com/electron/electron/issues/30479) 记录的是旧版 Electron
可能把 iframe 活动也反映到 `did-start-loading`/`did-stop-loading`；这是历史 issue
证据，不是当前 Electron 39 的保证。当前运行时样本没有产生 subframe navigation
事件，因此 `www.baidu.com` 的重复 loading state 不能据此证明是 iframe 活动。

Electron 官方的[Navigation History 示例](https://www.electronjs.org/docs/latest/tutorial/navigation-history)
用 `navigationHistory.goBack()`/`goForward()` 执行历史命令，并在 `did-navigate` 与
`did-navigate-in-page` 中发送独立的导航更新通知；它没有把这些通知再转成 `loadURL`。
React 官方的 [`useEffect` 指南](https://react.dev/reference/react/useEffect) 也说明依赖项用
`Object.is` 比较，提醒在 render 中创建的对象和函数会导致 effect 不必要地重复执行，并建议把
effect 的 setup/cleanup 设计成独立的同步过程。

因此，在实现前需要分开验证两件事：loading indicator 使用主 frame/文档感知的信号；native 导航观察保持单向，不能重新进入显式的 `loadURL`/`navigate` 路径。已观测到的 `-3` 是第二次加载造成的取消，不是 `CONNECTION_RESET`（`-101`）。Electron 在 2025 年针对
`loadURL` 重入问题的修复（[PR #48004](https://releases.electronjs.org/pr/48004)）也说明不应从导航回调中同步或重入调用 `loadURL`。

## 验证限制

当前 active E2E registry 没有 Browser 导航 journey，因此 P0 smoke 的 5/5 通过并不覆盖这个 surface。现在已有 controller 回归测试覆盖该约束，但 focused Vitest 仍被 package 已有的 React 19 测试环境问题阻断：现有套件期望导出的 `act` 不存在。组件 package typecheck 和 Electron build 已通过。`pnpm run docs check` 完成并只有已有 warning，没有 error。
