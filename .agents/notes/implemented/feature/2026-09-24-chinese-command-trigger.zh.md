# 中文命令菜单触发符

Status: implemented
Translation: current

[English](2026-09-24-chinese-command-trigger.md)

## 摘要

命令菜单原先要求 ASCII 斜杠，中文输入用户需要切换标点。
输入框现在同时注册 `、` 和 `/`，注册表将两者路由到同一组候选。
选中后保留标准斜杠 token，以及命令必须独占输入框的限制。
Shortcuts 保留行内使用行为；未选择的文本不变。

## 决策与证据

将新标点作为菜单入口别名，而非全局改写输入框文本，避免影响普通正文和下游命令协议。
输入框负责触发符可用性与整段输入限制，注册表负责候选路由。
Shortcut 调用继续使用已有的 slash-menu 来源分类。
详见[行为草案](../../../../specs/command-mention-triggers.zh.md)。

现有输入框测试覆盖两个前缀、筛选、键盘选择以及混合正文排除。
原生中文输入法仍需手动验证；合成输入事件测试不能证明操作系统输入法行为。

## 验证

输入框与菜单注册表的定向测试全部通过，共 37 项。`NODE_ENV=test pnpm check`、`pnpm format` 和 `pnpm run docs check` 均通过。
组件包的 492 个测试文件、4015 项测试全部通过。
原生输入法交互仍需手动验证。

PR: [#934](https://github.com/LodyAI/Lody/pull/934).
