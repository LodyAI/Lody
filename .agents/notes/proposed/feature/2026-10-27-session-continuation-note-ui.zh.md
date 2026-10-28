# 会话自动接续 UI：是一条便签，不是一个面板

日期：2026-10-27
状态：proposed
翻译：current

[English](2026-10-27-session-continuation-note-ui.md)

## 摘要

第一版 UI 把持久化的会话自动接续当成了一个产品功能面：右侧面板、状态胶囊、
设置页和活动流。结果一个小把戏看起来像控制台。现在的方向是：对话末尾一条安静
的便签、一个只放检查信息的小弹层，以及藏在会话菜单里的三个 per-session 小开关。
UI 绝不能把“送达未知”说成成功；只有被 Stop 挡住的接续才升级成一条直接提示。
展示组件、Storybook 和测试已经落地；桌面端可读取和管理本机 Host 上的等待。
跨设备和 Web 使用仍需单独的授权契约。

## 决定

- 一条便签，不是面板。不新增右侧 tab、不新增一级导航，也不引入功能级状态词。
  对话本身就是承载面。
- 便签和开关需要同时启用开发者模式与默认关闭的“会话自动继续”Beta 开关。
  此开关只控制 UI，不提供自动化授权；关闭开发者模式会隐藏 UI，
  但保留用户的开关选择。
- 便签只放 Agent 自己的那句话、一个倒计时和一个动作。检查次数、程序源码和证据
  留在弹层里，不做主界面。弹层使用统一间距 token，标题、说明和详情行共享图标与
  文本对齐网格。
- `settled`、`cancelled`、`expired` 直接离开便签。`matched` 不等于“完成”：
  排队、运行、被挡住、送达未知各有诚实的文案。
- 被 Stop 挡住的接续升级成一条提示，提供“恢复会话 / 取消等待”；UI 绝不自己清 Stop。
  权限、不可用和失败状态同样不伪装成成功。
- 三个行为是会话菜单里的 per-session 开关，不是设置页：额度恢复、合并后归档、
  空闲压缩。当前 Provider 不支持时，Host 可以禁用某一项并给出原因。
- 视图模型刻意很小：阶段、下次检查、上次检查、过期时间、送达状态和阻塞原因。
  原始程序、ledger receipt、binding 和 evidence 不进入 renderer。

## 证据与限制

- `packages/components/src/components/sessions/session-continuation.ts` 负责状态折叠；
  `session-continuation-note.tsx` 和 `session-continuation-tweaks.tsx` 是两个界面。
  Storybook 覆盖等待、排队、被 Stop 挡住、失败、离线、送达未知和手机形态。
- 额度恢复目前只在 Claude Code 和 Codex 订阅账号上验证可用。Claude 和 Codex
  都上报 `rateLimits.query`；Codex 必须是 ChatGPT profile。Grok 有资格判断分支，
  但当前 checkout 的扩展未初始化，仍属未验证。其他 builtin adapter 没有
  `rateLimits.query`；API-key、branded、Magpie 和凭据覆盖配置都不符合资格。
  旧的 Claude 专用 `continue` 快捷方式已在同一次改动中退休；已有预约仍然是普通
  定时消息。
- 本机 Electron 通过限定范围的 IPC 列出、取消等待并读取、修改会话设置。会话可见时
  轮询 Host；读取失败显示不可用，切换会话时丢弃迟到的结果。返回 renderer 前过滤
  Host 数据。远程机器、Web、能力发现和针对 Stop 的恢复操作仍未接入。
- 这个 worktree 没有安装 `node_modules`。三个新套件借用同仓库另一个 worktree 的
  已安装工具链跑过：18 个测试通过。package 级 typecheck 仍有跨 worktree 的既有错误，
  但新文件没有错误；Storybook 没有在这里启动。人工视觉审查仍然待做。
- 后端契约和策略仍由
  [automation coordinator 笔记](../architecture/2026-10-25-session-automation-coordinator.md)拥有。
