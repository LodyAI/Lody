# 菜单选项使用普通字重

Status: implemented
Translation: current
PR: [#1163](https://github.com/LodyAI/Lody/pull/1163)

[English](2026-09-30-menu-regular-weight.md)

## 摘要

共享菜单继承了 500 字重，而侧边栏筛选浮层使用 400，让平级选项出现不同的强调程度。
菜单标签现统一使用 400，包括 composer 选择菜单和 mention 菜单。
分组标题和搜索命中保留强调，普通控件保留现有的文字角色。
此改动降低菜单的视觉强调，不改变选择和导航行为。

## 决策

[菜单组件决策](../feature/2026-09-11-ui-menu-primitives.md)仍负责共享菜单行为。
本次部分替代其中将通用控件文字规则用于命令行的选择。当前意图见
[菜单字重 Spec](../../../../specs/menu-typography.zh.md)，构造规则仍由
[token 使用规则](../../../../packages/ui/src/tokens/RULES.md#menus)负责。

在 `popupMenu` 中覆盖字重，而不修改基础浮层：Select 和 Combobox 字段保留控件字重，
浮层正文保留自己的文字角色。菜单栏标签遵循菜单规则。
Composer 选择与 mention 样式自行渲染选项列表，因此同步声明该字重。

所有菜单继续使用 500 可维持旧组件内部的一致性，但会保留用户指出的过度强调。
逐菜单覆盖 class 会分散决策并遗漏子菜单。共享声明让平级命令使用普通字重，
同时保留标题与搜索命中字符的强调。

## 验证

在包含相同改动源码的独立 clone 中执行：

- `pnpm --filter @lody/ui typecheck` 通过。
- UI 菜单、浮层和 gallery 套件通过（57 项测试）；产品菜单、会话头部、权限、附件和
  mention 套件通过（57 项测试）。
- Playwright 使用现有 Storybook 示例截取修改前后图。会话、运行配置、模型子菜单、
  附件/MCP 和 mention 行的计算字重从 500 变为 400；侧边栏筛选行保持 400。
  两轮截图均未报告页面异常。截图使用合成示例数据。
- 改动文件的 Oxfmt、Oxlint 和 `git diff --check` 通过。
- root `pnpm format`、typecheck 和 lint 通过。完整 `pnpm check` 在
  `boot-shell.test.tsx` 的存储不可用用例处停止（components 中 1 项失败，4559 项通过）。
  同一 clone 的未修改基线也复现该失败。Electron 测试未执行到。
  后续 i18n 及 import/platform/public-boundary 检查单独执行并通过。

删除了统计生成 CSS class 数量的菜单测试：它验证样式数量而非用户行为。
现有键盘、指针、开关和子菜单覆盖仍保留，Playwright 检查了实际渲染的字重。

`pnpm run docs check` 报告当前工作树中 62 个指向缺失 ACP
子模块文件的既有断链，均不属于本次改动。Spec 保持 draft。
截图产物保存在本地，不纳入 Git。
