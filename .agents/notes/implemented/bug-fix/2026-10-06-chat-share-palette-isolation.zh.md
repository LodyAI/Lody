# 将分享图片的配色与应用主题隔离

Status: implemented
Translation: current
PR: [#1281](https://github.com/LodyAI/Lody/pull/1281)

[English](2026-10-06-chat-share-palette-isolation.md)

## 摘要

在深色应用中选择浅色对话分享图片，会让助手正文几乎不可见；Usage 团队卡片的默认
头像也保留了应用配色。两处故障均来自在应用根节点解析的 StyleX 别名。卡片现在
就地绑定所选产品配色，以及各自的对话或头像主题；代码块的深色样式也遵循卡片
作用域。Chromium 复现和配色切换验证了修复，并完成了对话和 Usage PNG 下载；本次未测试
Electron 原生导出。

## 证据与决策

仓库版本 `9b8cd7715` 在深色应用中渲染浅色卡片时，背景为
`rgb(239, 239, 241)`，助手正文却为 `rgb(228, 229, 231)`，对比度只有 1.10:1。
加粗文字为 `rgb(240, 241, 242)`，用户提示和底部说明则正确使用浅色 CSS 变量。
这解释了两种角色文字清晰度的差异，故障并非 PNG 编码造成。

[Markdown 的 StyleX 迁移](../simplification/2026-10-03-conversation-rhythm-stylex.zh.md)
引入了对话语义别名。CSS 自定义属性在声明处解析引用，后代覆盖被引用的变量，
不会重新解析继承来的别名。现有 `ensureShareThemeScopes` 因而只能覆盖传统 CSS
消费者，无法隔离 StyleX Markdown 渲染器。代码块也会在浅色卡片内匹配 `.dark *`。

[对话 token 定义](../../../../packages/components/src/components/ai-gui/conversation.tokens.stylex.ts)
让 `defineVars` 和 `scopedConversationTheme` 共用一个默认值对象。
[卡片](../../../../packages/components/src/components/share-card/chat-share-card.tsx)在原有
浅色或深色 CSS 作用域旁，应用该主题和完整的所选产品配色。这让正文、强调、引用、
表格和代码颜色按卡片自己的变量重新解析。代码块深色选择器也识别 `.dark-scope`，
并排除 `.light-scope`。

后代前景色覆盖只能修正普通正文，会让强调、次要文字和代码表面继续使用错误配色。
局部语义主题覆盖这些角色，无须改写共享 Markdown 元素样式或
[固定模板](../feature/2026-09-14-chat-share-card-fixed-template.zh.md)。修复后的浅色
正文为 `rgb(29, 29, 32)`，在相同背景上的对比度为 14.64:1。卡片布局、主题控件
和导出流程保留原有职责。

### Usage 与作用域排查

[Usage 卡片](../../../../packages/components/src/components/settings/usage-share-card.tsx)
的总量、标签和图表直接使用作用域内的 CSS 变量。团队成员的默认头像却继承了头像
语义别名：深色应用中的浅色卡片，头像字色为 `rgb(215, 216, 217)`，底色为
`rgb(46, 46, 46)`；同一张卡片放在浅色应用中，则是 `rgb(26, 27, 30)` 字色和
`rgb(230, 232, 237)` 底色。两种组合都能阅读，这属于主题串色，不是对话正文
几乎不可见的问题。

固定配色的 Usage 卡片现在在卡片作用域应用完整的所选产品配色和已有的
`avatarPaletteTheme`。UI 包导出该主题的 token 模块以支持这一组合。未指定卡片
配色时仍正常继承应用主题。源码排查确认，只有对话和 Usage 分享卡片创建
`light-scope` / `dark-scope` 边界，其他匹配组件只消费这些选择器。本次排查明确了
这两个导出边界，并不证明应用内所有主题作用域或可视化都正确。

## 验证与限制

[字体浏览器测试](../../../../packages/components/tests/e2e/interface-typography.spec.ts)
新增四种应用与卡片主题组合，并使系统外观与应用主题相反；另有两项连续切换配色的
用例。测试检查实际计算颜色、代码换行、隐藏复制控件，以及应用主题保持不变。
浅色卡片与深色应用的用例在原生产代码上因正文继承错误颜色而失败；修复后六项全部
通过。另有十二项 Usage 用例覆盖两种画幅与全部应用、卡片配色组合，未固定配色时
继承应用主题，以及对话框连续切换。Usage 原文件准确地在默认头像字色检查上失败；
修复后，对话和 Usage 共十八项用例在 Playwright 自带 Chromium 中通过。所有数据均为
合成数据。Usage 统计、日历与导出单元测试共 33 项通过，UI 包类型检查通过。仅新增
导出路径的 manifest 修改重新生成锁文件后未产生差异，因为依赖没有变化。

Playwright 对真实卡片和分享对话框拍摄了修复前后截图。实际点击两个对话框的「导出 PNG」
完成了浏览器下载，并检查了对话图片的文字、语法颜色，以及 Usage 成员头像。Usage
修复前后截图也通过 Lody 上传。导出、代码辅助函数及主题 CSS
单元测试全部 26 项通过，改动文件 lint 通过。组件类型检查在原生产文件和修改后的
文件上均报告相同的 27 个错误，原因是缺失预览器依赖和复用依赖的 API 不兼容。
类型检查未通过。要求执行的 `pnpm check` 因缺少 `fumadocs-mdx`，在文档站类型
检查前的生成步骤停止；`pnpm format`、平台边界、Code Collab 导入和 i18n 键检查
通过。公开仓库边界检查无法解析另外四个未初始化的适配器 workspace 包。
扩大范围的字体测试通过了六项分享用例，
但在现有对话 fixture 上停滞，因此已停止。文档检查报告了其他未初始化 ACP 子模块的
链接缺失，没有错误涉及本次修改的文档。本次未验收 Electron 原生保存与剪贴板，
也未验收 Mermaid 图表配色。
