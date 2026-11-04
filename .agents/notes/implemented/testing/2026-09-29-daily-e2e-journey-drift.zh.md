# 将 Desktop Daily 旅程与当前界面和 ACP Session 对齐

Status: implemented
Translation: current

[English](2026-09-29-daily-e2e-journey-drift.md) | 中文

## 摘要

桌面界面变化后，Desktop Daily 的 #507 持续失败：多处 Page Object 仍按已废弃的角色查找控件，或把共享状态标记误当成单一状态的证据。旅程现改为使用当前可访问控件、区分 Turn ACP Session 与标题生成 Session，并在终端 relay 短暂断线时继续等待，同时仍要求实际观察到清理完成。10 月 25 日运行在每个平台均通过 24 个旅程中的 22 个；Role 机器选择与归档确认修正保留了配置冻结和 Session 生命周期断言。本地完整回归还发现合成 ACP 在历史重放后选择响应错误，修正未改变产品行为。Issue 关闭前仍需一次新的三平台完整 Daily 运行。

## 证据与决定

[9 月 29 日完整 Daily 运行](https://github.com/LodyAI/Lody/actions/runs/36539627906)在 macOS、Linux 和 Windows 上均完成构建，每个平台的 24 个场景中有六到七个失败。macOS 和 Linux 日志反复显示：`Agent Provider` 标题已不存在，主题按钮和预览项定位仍沿用旧控件，目标详情把当前 popover 当作旧 dialog 查找，而项目移除定位同时命中确认对话框与成功 toast。上下文复制误选页面上的第一个分叉按钮，使菜单项一直在视口外。Linux 还在历史与待发送消息区域同时找到相同的附件提示。这些属于定位错误；替换后的断言仍指向用户实际操作或查看的那条消息。

MCP 启动断言原本选取最后一条 `session-new` 事件。标题生成会另起一个没有 Turn MCP 选择的 ACP Session，最后一条事件因此可能属于标题。合成 ACP fixture 现利用已有的 `LODY_TITLE_AGENT` 环境标记区分标题与 Turn；旅程等待 Turn Session 及其对应提示完成后再检查 MCP 启动配置。如果 Turn 本身没有传入所选 MCP，断言仍会失败。

9 月 28 日运行的队列旅程在三个平台均失败：排队提示同时出现在页面的多个区域，全局文本定位因此命中多个元素。队列 Page Object 现通过 `Remove from queue` 控件及该行提示找到目标行。9 月 29 日该旅程通过，但模糊定位仍是可重复的失败来源。

Windows 上，Session 归档后的第一次 `terminal.list` 返回 `terminal_socket_closed`。终端 relay 会在 socket 关闭时拒绝在途请求，并在下次请求时重新连接。清理轮询现将该传输错误视为未达成条件，继续等待 relay 返回空终端列表；持续不可用仍会超时。这尚不能说明 socket 为何关闭。

Windows 的分叉与 Session 管理旅程在源提示后超时。[artifact 的截图和 trace](https://github.com/LodyAI/Lody/actions/runs/36539627906)显示源回复已在预期项目下完成。旧 fixture 仅通过记录的 `cwd` 与合成项目根目录的 `realpathSync` 相等来查找 ACP 提示事件；artifact 没有保留 ACP 事件日志，因此无法确定具体的路径差异。fixture 现标记标题与 Turn ACP Session，并按 Turn Session id 关联已完成提示；合成事件日志也会留在场景 artifact 中，供以后诊断路径问题。

[PR 的首次完整运行](https://github.com/LodyAI/Lody/actions/runs/36563017669)在 macOS 通过了 24 个旅程中的 22 个。失败截图显示主题选择器是带 `role="combobox"` 的按钮，Playwright 的 button-role 定位无法找到它。删除最后一个 Agent Provider 后，当前机器空状态显示 `No agents on <machine> yet`，而非旧文案 `No providers on this machine yet.`。后续断言已按实际角色及两种支持语言的当前空状态文案修正。

[PR 的后续完整运行](https://github.com/LodyAI/Lody/actions/runs/36570175372)完成桌面构建，24 个 macOS 旅程、249 个步骤全部通过，包括之前失败的两个设置旅程。

随后一次[仅更新 Note 的完整运行](https://github.com/LodyAI/Lody/actions/runs/36572327622)通过了 24 个旅程中的 23 个：上下文复制打开了首条用户消息的唯一菜单项，但虚拟列表将锚点移到了视口上方。trace 记录了菜单 positioner 的负数纵坐标，且会话停在底部，所以 Playwright 鼠标点击一直等待视口外的菜单项。[下一轮运行](https://github.com/LodyAI/Lody/actions/runs/36574680042)又推翻了键盘焦点方案：打开的菜单项没有自动取得焦点。旅程现在先在会话区域使用真实的向上滚轮操作，并等待滚动位置归零，再打开首条消息菜单。它保留鼠标点击及剪贴板前缀、排除项断言；菜单若不可操作仍会失败，不会被绕过。

[9 月 30 日运行](https://github.com/LodyAI/Lody/actions/runs/36687531414)暴露了两个独立的观察错误。Session 行标记可表示未读、执行中、发送中或权限请求，因此不能凭它决定旅程是否需要标记未读。旅程现读取菜单中的读状态操作，并保留已有的标记和重新打开断言。Windows 上，worktree 清理后 relay 重连期间，`terminal.list` 可能返回 `terminal_socket_closed`、`terminal_socket_unavailable` 或 `daemon_unavailable`。这些错误仍是未匹配的轮询结果；只有一次成功返回的空终端列表才能证明清理完成，持续不可用仍会超时失败。

[10 月 7 日运行](https://github.com/LodyAI/Lody/actions/runs/37592246516)在 macOS、Linux 和 Windows 上都失败于 MCP 删除及项目重新打开。MCP 设置已用 tab panel 替换旧的 `main` landmark，但仍保留产品自有的 `data-settings-surface`；删除定位现使用该 surface，并保留可访问名称、确认、删除及先前 Turn 的断言。项目选择器现把项目渲染为 `menuitemradio`，Page Object 因此按当前角色和精确项目名定位，同时保留唯一选项断言。Windows 还复现了上述终端 relay 中断；该运行早于清理观察修正。

## 10 月 25 日：Role 机器标签页与显式归档范围

[10 月 25 日完整 Daily](https://github.com/LodyAI/Lody/actions/runs/40172314079)在三个平台均成功构建，仅 `LODY-ROLE-001` 与 `LODY-SESSION-004` 失败。Linux 截图确认：Role 编辑器已显示选中的本机标签页，测试却仍在等待旧机器下拉框的选项；归档旅程则停在尚未回答的子对话确认框。这些失败不能证明产品回归。

Role Page Object 现从名为“机器”的 tablist 中选择唯一机器标签页，检查选中状态后再选择准确的合成 Agent 配置。全新隔离桌面只有一台本机，意外出现其他标签页会明确失败。原有的 Role 标识、版本、精确机器/配置组合、编辑和删除后的指令冻结及清理断言全部保留。当前编辑器遵循[多机器 Role 契约](../../../../specs/agent-role-machine-targets.zh.md)。

关系生命周期旅程现在在可见 alertdialog 中明确点击“全部归档”，等待关闭后再观察归档状态。这遵循[子对话归档确认决策](../feature/2026-10-22-archive-sub-conversation-confirmation.zh.md)：递归归档必须由用户选择。旅程仍要求四个 Session 全部归档、opened worktree 和进程释放、永久删除根会话时只删除根及其 child Tab，并且独立 opened Session 保留 dangling 溯源。通过 API 绕过确认框或削弱这些断言，都会漏掉用户实际经历的契约。

## 恢复后的上下文复制 fixture

当前 main 基线的本地完整运行还暴露了 `LODY-CONTEXT-001` 的独立失败：Stop 后自定义 ACP Session 重建，输入为旧对话上下文加 `=== Current Request ===`。保留的 wire 中，第一条富文本提示位于历史部分，新的完成请求位于末尾。模拟器按第一个命中的标记选响应，误选历史里的富文本提示；界面因此正确显示了错误的合成响应，无法出现期望的完成尾段。

模拟器现仅在存在重放封装时按当前请求后缀分类，普通提示仍按原逻辑分类。真实的 Stop、重建、历史重放路径，以及现有的剪贴板前缀、未完成/完成响应和 Session 隔离断言全部保留。直接 ACP wire 检查证明普通富文本响应和恢复后的完成响应均正确。[修复 PR](https://github.com/LodyAI/Lody/pull/1868)包含此 fixture 修正，不改变 CLI 重放契约。

## 验证与限制

同样四处有界 Page Object 修正在 [PR #1175](https://github.com/LodyAI/Lody/pull/1175) 通过了远程静态检查、测试分片和桌面 smoke；[PR #1318](https://github.com/LodyAI/Lody/pull/1318) 在当前 `main` 基线上交付这些修正，并保留了前者的贡献归属。当前嵌套 worktree 按规则未安装依赖，`pnpm --filter @lody/e2e check` 因此无法启动；shell 还选中了不受支持的 Node.js 26.10.0。仓库指引要求此处跳过 `pnpm install`，所以构建后的 Electron 旅程交由 PR CI 验证。Issue #507 仍以 macOS、Linux 和 Windows 的完整 Daily 成功作为关闭信号。

10 月 25 日本地验证：两个修复后的旅程在 Linux 上构建的 OSS Electron 桌面均通过（2 个场景、17 个步骤），包括原有清理断言。`pnpm --filter @lody/e2e check` 的套件契约、dry run、TypeScript 检查及 49 项支持测试通过。桌面构建、根格式化、变更文件格式化、文档检查（0 错误、73 条既有警告）、工作区类型检查、lint/Effect lint、国际化和全部边界检查通过。根 `pnpm check` 的测试遍历在未改动的 CLI Git/worktree 与 cloudflared fixture 出现无关失败后停止；单独重跑 SessionManager 本地副本用例，也在临时 fixture 中复现了 `fatal: not a git repository`。不声明全仓测试通过。三平台完整 Daily 恢复仍待验证。
