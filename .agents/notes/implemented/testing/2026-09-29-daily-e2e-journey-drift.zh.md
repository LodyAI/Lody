# 将 Desktop Daily 旅程与当前界面和 ACP Session 对齐

Status: implemented
Translation: current

[English](2026-09-29-daily-e2e-journey-drift.md) | 中文

## 摘要

桌面界面变化后，Desktop Daily 的 #507 持续失败：多处 Page Object 仍按旧标签查找控件，或同时匹配无关的浮层。旅程定位现改为指向当前控件及其所属的消息或对话框。MCP 和分叉旅程将 Turn 的 ACP Session 与独立的标题生成 Session 区分开；worktree 清理在终端 relay 短暂断线时继续检查，但仍须实际观察到资源释放。PR 完整运行又揭示两处旧设置定位及偶发位于视口外的菜单；设置修正在一次 macOS 运行中通过了全部 24 个旅程，菜单旅程现先将会话滚到首条消息，再打开菜单。Windows 和 Linux 仍待新的 Daily 验证。

## 证据与决定

[9 月 29 日完整 Daily 运行](https://github.com/LodyAI/Lody/actions/runs/36539627906)在 macOS、Linux 和 Windows 上均完成构建，每个平台的 24 个场景中有六到七个失败。macOS 和 Linux 日志反复显示：`Agent Provider` 标题已不存在，主题按钮和预览项定位仍沿用旧控件，目标详情把当前 popover 当作旧 dialog 查找，而项目移除定位同时命中确认对话框与成功 toast。上下文复制误选页面上的第一个分叉按钮，使菜单项一直在视口外。Linux 还在历史与待发送消息区域同时找到相同的附件提示。这些属于定位错误；替换后的断言仍指向用户实际操作或查看的那条消息。

MCP 启动断言原本选取最后一条 `session-new` 事件。标题生成会另起一个没有 Turn MCP 选择的 ACP Session，最后一条事件因此可能属于标题。合成 ACP fixture 现利用已有的 `LODY_TITLE_AGENT` 环境标记区分标题与 Turn；旅程等待 Turn Session 及其对应提示完成后再检查 MCP 启动配置。如果 Turn 本身没有传入所选 MCP，断言仍会失败。

9 月 28 日运行的队列旅程在三个平台均失败：排队提示同时出现在页面的多个区域，全局文本定位因此命中多个元素。队列 Page Object 现通过 `Remove from queue` 控件及该行提示找到目标行。9 月 29 日该旅程通过，但模糊定位仍是可重复的失败来源。

Windows 上，Session 归档后的第一次 `terminal.list` 返回 `terminal_socket_closed`。终端 relay 会在 socket 关闭时拒绝在途请求，并在下次请求时重新连接。清理轮询现将该传输错误视为未达成条件，继续等待 relay 返回空终端列表；持续不可用仍会超时。这尚不能说明 socket 为何关闭。

Windows 的分叉与 Session 管理旅程在源提示后超时。[artifact 的截图和 trace](https://github.com/LodyAI/Lody/actions/runs/36539627906)显示源回复已在预期项目下完成。旧 fixture 仅通过记录的 `cwd` 与合成项目根目录的 `realpathSync` 相等来查找 ACP 提示事件；artifact 没有保留 ACP 事件日志，因此无法确定具体的路径差异。fixture 现标记标题与 Turn ACP Session，并按 Turn Session id 关联已完成提示；合成事件日志也会留在场景 artifact 中，供以后诊断路径问题。

[PR 的首次完整运行](https://github.com/LodyAI/Lody/actions/runs/36563017669)在 macOS 通过了 24 个旅程中的 22 个。失败截图显示主题选择器是带 `role="combobox"` 的按钮，Playwright 的 button-role 定位无法找到它。删除最后一个 Agent Provider 后，当前机器空状态显示 `No agents on <machine> yet`，而非旧文案 `No providers on this machine yet.`。后续断言已按实际角色及两种支持语言的当前空状态文案修正。

[PR 的后续完整运行](https://github.com/LodyAI/Lody/actions/runs/36570175372)完成桌面构建，24 个 macOS 旅程、249 个步骤全部通过，包括之前失败的两个设置旅程。

随后一次[仅更新 Note 的完整运行](https://github.com/LodyAI/Lody/actions/runs/36572327622)通过了 24 个旅程中的 23 个：上下文复制打开了首条用户消息的唯一菜单项，但虚拟列表将锚点移到了视口上方。trace 记录了菜单 positioner 的负数纵坐标，且会话停在底部，所以 Playwright 鼠标点击一直等待视口外的菜单项。[下一轮运行](https://github.com/LodyAI/Lody/actions/runs/36574680042)又推翻了键盘焦点方案：打开的菜单项没有自动取得焦点。旅程现在先在会话区域使用真实的向上滚轮操作，并等待滚动位置归零，再打开首条消息菜单。它保留鼠标点击及剪贴板前缀、排除项断言；菜单若不可操作仍会失败，不会被绕过。

## 验证与限制

改动文件通过 Oxfmt 和 `git diff --check`。此嵌套 worktree 的 E2E 包未安装 `@cucumber/cucumber`，所以 `pnpm e2e:check` 无法启动；`pnpm e2e:build` 因 CLI 清理步骤缺少 `rimraf` 而停止。根目录的 `pnpm check` 和 `pnpm format` 也因工具缺失而停止。仓库指引要求嵌套 checkout 跳过 `pnpm install`，因此无法在本地启动构建后 Electron smoke。`pnpm run docs check` 报告 62 条指向未填充 ACP submodule 路径的断链，新建的双语 Note 没有相关错误。设置修正已在一次托管 full 运行中通过；显式滚动调整及 Windows、Linux 运行仍待新一轮托管验证。

[10 月 5 日 Daily 运行](https://github.com/LodyAI/Lody/actions/runs/37283733099)还失败于 `LODY-PROJECT-002`：trace 等待项目 `menuitem`，可见选择器却已采用单选项。main 在 `6da6168e95758e4d1b876894c408a0641519455b` 将这些选项改为 `Menu.RadioItem`，本 PR base 则仍渲染 `Menu.Item`。Page Object 的选择操作与单一选项断言现接受这两种可访问角色，仍要求项目名精确匹配。数量断言保留，因此重复选项仍会失败；文件夹操作及产品行为不变。
