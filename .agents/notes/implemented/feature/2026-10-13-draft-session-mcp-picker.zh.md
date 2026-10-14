# 子 Session 首条消息前的 MCP 选择

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1541

[English](2026-10-13-draft-session-mcp-picker.md)

## 摘要

空白子标签页此前不提供 MCP 选择器，首条消息使用工作区默认选择。
这是 PR #141 明确记录的已知限制，而不是已有能力被意外破坏。
本次传入现有 hook 的菜单，增加首轮选择能力，无需增加存储或改变派发。
开发阶段验证了选择、取消选择和空目录；草稿组件测试不保留在 PR 中，
尚未启动修改后的桌面端验证。

## 原有行为与决定

`DraftSessionChatInterface` 调用了 `useSessionMcpSelection`，却没有向
`SessionChatInputArea` 传入 `mcp`。首次发送后，正式 session 界面会传入该属性，
因此菜单随后出现。Chat Landing 原本就会在发送前传入菜单。
共享输入框的[约定](../../../../packages/components/src/components/chat/AGENTS.md)
要求每轮 MCP 选择放在 “+” 菜单，并在目录为空时隐藏入口，
但不能据此证明原来的草稿行为违反了已审核的产品意图。

[PR #141](https://github.com/LodyAI/Lody/pull/141) 在修复草稿转为正式 session 和
首条消息接纳时引入此 hook。注释明确说草稿“暂时”没有选择器，所以首轮使用
工作区默认选择，与正式输入框在空 session 文档上解析出的结果保持一致。
默认选择只包含 `enabledByDefault: true` 的服务，不是全部目录项，也不是父
session 的选择。本次改动补齐这一已知限制，而非恢复曾经存在的选择器；
此处纠正此前的 bug 分类。

复用 `mcpSelection.menu` 和已有首轮配置构造逻辑。等待发送后才选择会使首轮无法
使用用户指定的 MCP；新增草稿或 session 存储会扩大范围，也不能解决漏传属性。
选择继续使用 hook 原有的组件内生命周期，并遵守
[共享约定](../../../../packages/shared/AGENTS.md#workspace-mcp--roles)，保留显式空数组。

## 验证与限制

- 分支已 rebase 到上游 `cf1afac6a`，包含 PR #1548 的冻结安装修正。
  在包含全部 25 个工作区固定版本 manifest、根锁文件及工作区设置的隔离环境中，
  `pnpm install --frozen-lockfile --lockfile-only --ignore-scripts` 通过。
  这验证了锁文件一致性，但未安装二进制或运行构建；完整 CI 仍待验证。
  本地子模块检出状态保持不变。
- 临时草稿组件测试通过替代输入框验证了首轮选择、取消选择和空目录，
  在原来的仅默认选择行为下失败，传入菜单后通过。测试验证新增能力，
  不能证明旧产品意图。该测试不保留在 PR 中，目前没有覆盖新增菜单连接的
  草稿组件自动化测试。
- 保留的草稿标签页、输入框提交、附件菜单和 session 操作测试覆盖相邻行为，
  删除测试后重新运行，四个文件共 150 项通过。rebase 后前三组再次运行，
  73 项通过。完整桌面端端到端验证仍待完成。
- `pnpm check` 在 shared 包类型检查阶段被已有本地 DSH 子模块阻挡，其导出缺少
  `DEEPSEEK_HARNESS_OFFICIAL_BASE_URL` 和 `isDeepSeekOfficialBaseUrl`。
  保留了原有子模块改动。
- `pnpm format`、本次代码与记录的 Oxfmt、Oxlint 和差异空白检查通过。
  根命令通过 `PATH` 使用已安装的 Homebrew Node 24/Corepack。README 中已有的
  表格格式差异不纳入本次修改。`docs check` 报告
  2026-10-10 工具结果格式中英文旧记录的两处链接失效，均指向缺失的 DSH
  `src/session-history.ts`；新增文档没有错误。

当前行为见 [session README](../../../../packages/components/src/components/sessions/README.md#conversation-surface-and-composer)。
