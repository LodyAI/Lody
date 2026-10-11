# 中文 Skill 菜单触发符

Status: implemented
Translation: current

[English](2026-10-02-yuan-skill-trigger.md)

## 摘要

中文输入用户此前只能通过 `$` 打开直接的 Skills 菜单。输入框现在也注册 `￥`，
菜单注册表将它路由到现有 Skills 分类。选中后仍插入 `$skill-name`，未选中的文本保持原样。
这提供了输入便利，而没有引入另一种持久化 Skill 语法。

## 决策与证据

沿用[中文命令触发符决策](2026-09-24-chinese-command-trigger.zh.md)，将其作为菜单别名，
而不是重写输入框文本。触发符注册保留 Skill 可用性条件；菜单路由保留懒加载和
Provider 过滤后的候选项。现有候选项插入逻辑已经提供规范的美元符号前缀。
[行为草案](../../../../specs/skill-mention-triggers.zh.md)记录了预期行为。

现有输入框测试覆盖两个前缀、提示词内触发、查询过滤、键盘选中后的规范形式，
以及取消时不改写文本。原生中文输入法行为仍需手动验证；合成输入事件不能证明它。

## 验证

输入框、菜单注册表和 Skill 来源的专项测试共 77 项通过。格式化、文档检查、全仓类型检查
和 lint、i18n 及边界检查通过。`pnpm check` 在未修改的 CLI
`workspace-git-service.test.ts` 的 remote 回填断言处中止（缺少 `githubRepoFullName`），
单独运行也能复现该失败，因此完整测试流程未全部完成。

PR: [#1208](https://github.com/LodyAI/Lody/pull/1208).
