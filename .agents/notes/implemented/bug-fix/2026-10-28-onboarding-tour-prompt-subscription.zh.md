# 保持 onboarding 演示 runtime 与输入组件兼容

Status: implemented
Translation: current

[English](2026-10-28-onboarding-tour-prompt-subscription.md)

## 摘要

桌面 onboarding 内嵌的真实会话输入组件订阅提示建议时，演示 runtime 缺少相应方法，导致页面崩溃。新用户因此无法进入 Agent 配置，六个 Desktop smoke 场景也全部失败。演示 runtime 现在通过相同的订阅接口立即提供空建议，不连接真实传输。正式产品的建议功能和 smoke 断言保持原样。

## 原因与证据

[提示建议集成](../feature/2026-10-27-prompt-suggestions.zh.md)为真实会话输入组件增加了 `useSessionPromptSuggestion`。Onboarding 通过 `TourStill` / `TourApp` 复用该组件。演示的独立 Jotai store 用类型断言发布了不完整的 `WorkspaceRuntime`，其中缺少 `subscribePromptSuggestion`，所以 hook 在 Agent 配置标题出现前抛错。

- [通过运行 40618838153](https://github.com/LodyAI/Lody/actions/runs/40618838153) 的 merge 为 `27feabc9cec318c685b9a6f0ad80bc8bf0e5c50e`：六个 P0 场景、42 步全部通过。
- [首次失败 40620755660](https://github.com/LodyAI/Lody/actions/runs/40620755660) 的 merge 为 `1d7d17b158ff2f636f8140cb1d6f1bb5b1cdad34`：#1951 自己的分支在合入 main 前已经包含新 hook。
- 首败及[运行 40622740264](https://github.com/LodyAI/Lody/actions/runs/40622740264) 的截图和 trace 都显示 onboarding 崩溃页，错误为 `TypeError: e.subscribePromptSuggestion is not a function`。后者的 CLI 日志显示本地 workspace 创建成功，Agent 服务已 ready。
- 通过与失败 job 都使用 `macos-15-arm64 / 20260907.0337.1`、provisioner `20260828.587`、构建 Node `22.23.4`、Electron `44.9.3` 和 Playwright `1.58.2`。两次的 lockfile、journey registry、feature 定义及 smoke workflow 相同。
- 02:20 UTC 的 `40620365356` 虽然 workflow 成功，但 Desktop job 被跳过，不能证明应用启动通过。

Main 上的首坏提交是 `55c6f1f80` 之后的 `574cfb00a`（#1951，02:33 UTC）。02:24 的失败来自 #1951 自己的分支，不能据此把回归定位到 main 的 02:05–02:24 提交区间。撤回 #1991 不会补齐演示的订阅接口。

## 决定

演示 runtime 负责只读订阅，正如它负责 repo 和 cloud 的演示数据。`subscribePromptSuggestion` 立即报告 `null`，并返回清理函数；使用正式订阅类型约束签名。不在真实 hook 中增加可选方法兜底，以免掩盖不完整的 runtime。无需覆盖 Agent 检测、删除断言或延长超时。

现有 TourApp 隔离测试现在在输入组件接入点调用真实建议 hook，并检查演示可见性数据与空建议都正确显示。它覆盖实际演示 store 与订阅边界，而不只是检查方法存在。

## 验证

扩展后的 TourApp 测试在未修复 main 上以 `runtime.subscribePromptSuggestion is not a function` 失败；修复后的 TourApp、tour repo 和建议 hook 三个测试文件共五个测试全部通过。

在独立 checkout 中构建真实 OSS 桌面及 bundled CLI，运行相同的 `@LODY-ONBOARDING-001` journey：

| 代码 | 结果 |
| --- | --- |
| #1951 之前的 `55c6f1f80` | 一个场景、八步全部通过 |
| 未修复的 #1951 `574cfb00a` | 复现 CI 的标题超时及缺少订阅方法的崩溃页 |
| `574cfb00a` 加五行演示修复 | 完整 smoke 六个场景、42 步全部通过 |

两次构建都使用 frozen lockfile 和各自准确的子模块提交；每次启动使用合成、可丢弃的独立配置目录。根格式及文档检查通过。工作区类型及静态检查通过，components 的 6,392 个测试、Electron 的 171 个测试通过。根 `pnpm check` 在未修改的 CLI 原生 Git fixture 以 `context_unreadable` 停止（CLI 其余 4,988 个测试通过，四个跳过）。移除会话注入的 Git 环境及 helper PATH 后，该 fixture 的 24 个测试全部通过；原完整检查仍不能记为全绿。
