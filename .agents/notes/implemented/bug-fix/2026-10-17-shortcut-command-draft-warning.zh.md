# Prompt Shortcut 命令字段改为提示合法性而非强制清洗

Status: implemented
Translation: current

[English](2026-10-17-shortcut-command-draft-warning.md)

## 摘要

Prompt Shortcut 编辑器的斜杠命令字段原先每次按键都执行 `slugify`，会把合法命令
中间态需要的字符直接删掉——输入 `a-b` 时刚敲下 `-` 就被剔除，根本打不出来。现在
字段保留原始草稿，改为报告合法性而不是强制执行：非法命令带上 `aria-invalid`，
并在字段上方悬浮一条 warning 提示；光标移开后若仍非法，草稿和提示都保持原样。
保存时仍由 `parsePromptShortcut` 校验，非法命令依旧无法写入。

## 决策

逐键清洗把“还没输完”和“非法”混为一谈：任何合法命令都会经过 `a-` 这类必然被
规范化改写的中间态。现在合法性是派生值（`SLUG_PATTERN` 加上 `maxLength` 已限制的
长度），不回写草稿，所以合法草稿在失焦时本身已是表单值，非法草稿也无需重置。
warning 是受控 `Popover`，锚定在字段上，`initialFocus`/`finalFocus` 关闭以免抢焦点；
并用 `slugTouched` 门控，避免新建编辑器里尚未触碰、仍随名称派生命令时闪烁提示。
保存被拒时会把 slug 标记为已触碰，让字段提示与保存错误信息保持一致。

输入框的 `pattern` 属性随清洗逻辑一并移除：不匹配的草稿现在是正常状态，而原生
约束校验气泡会先挡住提交，盖过 schema 自己的错误信息。`required` 保留——空命令
仍和名称字段一样走原生必填校验。

对 `packages/components` 全部 change handler 排查后，没有发现其它字段有同样缺陷。
workspace handle 系列输入框（`useWorkspaceSlugField`、onboarding 的 workspace 页）
本来就是“报错而不拒绝”：`normalizeWorkspaceSlugInput` 特意保留末尾 `-`，非法字符
留在草稿里交给内联 `Field.Error` 提示，只剥离合法 handle 不可能出现的序列（开头的
`-`、连续 `--`、大写）。Session/机器改名框只替换 `\r\n`，单行输入本来也打不出换行；
`normalizeAgentRoleDescription` 只是截断。

## 验证

`tests/prompt-shortcut-form.test.tsx` 覆盖三种行为：`a-b` 保留连字符且不提示；
`bad slug` 在失焦后保留原文与提示；新建编辑器未触碰时仍从名称派生 `my-command`
且不提示。`InvalidCommandWarning` Storybook story 可复现非法状态，Playwright 截图
已确认提示悬浮在字段上方（中英文均验证）。typecheck、oxlint、oxfmt 与
`lint:i18n` 均通过。
