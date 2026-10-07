# 快捷键设置搜索

Status: implemented
Translation: current

[English](2026-10-07-keyboard-shortcut-search.md)

## 摘要

快捷键设置页列出全部命令，但无法查找某个命令，也无法回答"这个按键绑定了什么"。现在列表上方新增搜索栏，可按名称和录制的按键筛选，两种条件以"与"组合。只要某行当前任一绑定与录制按键的规范形式相同即视为匹配，因此别名、修饰键顺序和次要绑定都能命中。按键录制复用各行重新绑定时使用的同一个捕获 hook；测试随改动一并编写，但撰写时尚未运行。

## 决策

- **名称筛选。** 对显示的（已翻译）标签、未翻译的 `title` 或命令 id 做不区分大小写的子串匹配，因此界面为中文时仍可用英文名或 id 找到对应行。查询会去除首尾空白，仅含空白时不筛选。在输入框中按 Escape 会清空非空查询。
- **按键筛选。** 输入框右侧的键盘按钮会启动 `useKeyCapture`，即各行重新绑定所用的 hook。它本身会暂停命令分发和系统全局快捷键，并取消其他正在进行的录制，因此搜索时按下的组合键不会触发命令，两个录制器也不会同时监听。录到的组合以按键标签显示，旁边带清除按钮。
- **匹配规则。** 双方都经过 `canonicalizeBinding`；比较 `commands.getKeybindingsFor` 返回的全部绑定，而非仅行中显示的主绑定。全局快捷键行按其实际生效的绑定匹配。未绑定的行永远不匹配按键筛选。
- **布局。** 没有匹配行的分类以及为空的全局分区会被隐藏；全部不匹配时页面显示一条"没有匹配的快捷键"提示。
- 匹配逻辑是 `packages/components/src/components/settings/keyboard-shortcuts-filter.ts` 中的纯函数，可在不渲染的情况下测试其规则。

## 备选方案

- 像命令面板一样使用模糊匹配：本页列表较短，子串匹配结果更可预期，故未采用。
- 为搜索单独实现捕获逻辑：没有必要。现有 hook 已能接受 Enter 等不带修饰键的单键（在没有修饰键按住时完成录制），因此原样复用。Escape 仍保留为取消录制，所以无法通过按键搜索单独的 Escape，可改用名称搜索。

## 限制

- 按键筛选生效时重新绑定某行，可能导致该行因不再匹配而消失，这是可接受的。
- 单元测试（`packages/components/tests/keyboard-shortcuts-filter.test.ts`）与 jsdom 渲染测试（`packages/components/tests/keyboard-shortcuts-setting-search.test.tsx`）随改动编写；它们、类型检查和 Storybook 均未在撰写环境中运行。
