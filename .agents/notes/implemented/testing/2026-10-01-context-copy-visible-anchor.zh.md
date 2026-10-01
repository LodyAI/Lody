# 上下文复制等待菜单锚点进入可见区域

Status: implemented
Translation: current

[English](2026-10-01-context-copy-visible-anchor.md)

## 摘要

10 月 1 日 Daily 上下文复制旅程在打开首条消息菜单前失败：向上滚动后，macOS
残留 1px、Ubuntu 残留 2px，而测试要求滚动位置严格为零。首条消息已经可见，因此
这次失败不能证明复制或导出有问题。旅程改为等待首条消息标记和 Fork 按钮完整进入
视口后再点击，保留真实指针交互和全部剪贴板验收。trace 尚不能确定这点滚动残留
的确切来源。

## 证据与决策

[Daily 运行](https://github.com/LodyAI/Lody/actions/runs/36835904880)测试了
`7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`，调查时 main 仍是该提交。
macOS、Ubuntu 的失败记录均指向
[`ContextCopyPage`](../../../../e2e/src/support/pages/context-copy-page.ts)
的精确零值轮询，发生在 Fork 菜单和剪贴板断言之前。两份 trace 都记录了向上
1000px 的滚轮操作，最后截图中首条消息位于会话可见区域内。轮询分别读到 1px、2px。

本项部分替代[9 月 29 日旅程漂移记录](2026-09-29-daily-e2e-journey-drift.md)
中的端点决策。先把虚拟化锚点滚入可见区域，确实能避免菜单出现在视口上方，
但严格要求 `scrollTop === 0` 增加了与交互目标无关的数值条件。PR #1175 没有
修改这个 helper。

改成 2px 容差能接受观察到的残留，但仍用滚动坐标代替真正的交互前提。现有
`LODY-CONTEXT-001` 回归改为在 hover 前确认首条提示标记完整进入视口，并在点击前
确认 Fork 按钮完整进入视口。即使锚点仍挂载且满足 Playwright 的 `toBeVisible`，
被裁切或离屏时也会失败。所属旅程继续保留原生滚轮、指针点击、菜单项点击、富
Markdown 包含、后续消息排除、流式状态、重开、隔离和清理验收。没有新增滚动写入方、
等待机制、产品行为或 Spec 意图。

## 验证与边界

- `pnpm e2e:check` 通过：套件约束、24 场景/249 步 dry-run、TypeScript、31 个
  脚本测试和 18 个 support/fixture 测试。worktree 使用忽略的链接读取已安装的 E2E
  依赖，没有在维护者 checkout 安装依赖或修改源码。
- 忽略的 Chromium 布局探针执行修改后的 Page Object，使用真实滚动元素、指针
  驱动菜单和浏览器剪贴板。输入偏移 0、0.5、1、2px 均通过精确前缀验收；本环境
  的 Chromium 将 0.5px 读回为 1px。40px 时部分裁切的提示、100px 时离屏的提示、
  2px 时离屏的 Fork 按钮均在打开菜单或改变剪贴板前失败。探针是合成 helper
  证据，不代表真实桌面集成测试。
- 本地 `pnpm e2e:build`、`pnpm check`、`pnpm format` 被缺失的 workspace 工具
  （`rimraf`、`tsgo`、`oxfmt`）及未初始化的 ACP 子模块阻挡。修改文件单独执行
  Oxfmt 检查和 `git diff --check`。PR 请求托管的真实 Electron 全套回归，后续结果
  由 PR checks 记录。
- 捕获的失败既不能证明残留只由亚像素取整造成，也未验证剪贴板行为：执行在复制
  前终止。新的 Windows/Linux 集成结果仍是单独的验证边界。

实现和托管验证通过本记录所属 PR 关联。
