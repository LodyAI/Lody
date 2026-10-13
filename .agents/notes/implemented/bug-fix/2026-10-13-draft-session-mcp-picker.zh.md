# 子 Session 首条消息前的 MCP 选择

Status: implemented
Translation: current

[English](2026-10-13-draft-session-mcp-picker.md)

## 摘要

空白子标签页在首次发送前不提供 MCP 选择，即使工作区目录已有服务。
草稿界面已经计算选择并将其写入首条消息配置，但渲染输入框时漏传菜单属性。
修复直接传入现有 hook 的菜单，无需增加存储或改变派发。
行为测试覆盖选择、取消选择和空目录；尚未启动修复后的桌面端验证。

## 原因与决定

`DraftSessionChatInterface` 调用了 `useSessionMcpSelection`，却没有向
`SessionChatInputArea` 传入 `mcp`。首次发送后，正式 session 界面会传入该属性，
因此菜单随后出现。Chat Landing 原本就会在发送前传入菜单。
共享输入框的[约定](../../../../packages/components/src/components/chat/AGENTS.md)
要求每轮 MCP 选择放在 “+” 菜单，并在目录为空时隐藏入口；草稿漏传属于实现遗漏。

复用 `mcpSelection.menu` 和已有首轮配置构造逻辑。等待发送后才选择会使首轮无法
使用用户指定的 MCP；新增草稿或 session 存储会扩大范围，也不能解决漏传属性。
选择继续使用 hook 原有的组件内生命周期，并遵守
[共享约定](../../../../packages/shared/AGENTS.md#workspace-mcp--roles)，保留显式空数组。

## 验证与限制

- 修复前，`draft-session-chat-interface.test.tsx` 因已配置服务没有可选控件而失败。
  修复后通过，并检查选择及取消选择后的真实首轮配置。
- 草稿界面、草稿标签页、输入框提交和附件菜单四组测试全部通过，共 75 项。
  草稿测试以消费公开属性的控件替代大型输入框，保留真实草稿组件、选择 hook 和
  消息配置构造逻辑；这不代表桌面端端到端验证。
- `pnpm check` 在 shared 包类型检查阶段被已有本地 DSH 子模块阻挡，其导出缺少
  `DEEPSEEK_HARNESS_OFFICIAL_BASE_URL` 和 `isDeepSeekOfficialBaseUrl`。
  保留了原有子模块改动。
- `pnpm format`、本次代码与记录的 Oxfmt、Oxlint 和差异空白检查通过。
  根命令通过 `PATH` 使用已安装的 Homebrew Node 24/Corepack。README 中已有的
  表格格式差异不纳入本次修改。`docs check` 报告
  2026-10-10 工具结果格式中英文旧记录的两处链接失效，均指向缺失的 DSH
  `src/session-history.ts`；新增文档没有错误。

当前行为见 [session README](../../../../packages/components/src/components/sessions/README.md#conversation-surface-and-composer)。
