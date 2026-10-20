# 在现有文字角色之上加一层视觉层级

Status: proposed
Translation: current

[English](2026-10-16-workspace-visual-hierarchy.md)

## 摘要

Lody 已有字号角色、间距约定和三档墨色，但没有规定哪类内容用哪一个，于是会话页由各组件自行选择并出现漂移：
164 处产品文字字号不跟随 Appearance，54 处墨色透明度分数在替代三档墨色。本笔记提出的是一层映射，而不是新的设计系统：
五个内容层级（阅读、证据、过程、元数据、外壳）和五条规则，记录在 [Spec 草案](../../../../specs/workspace-visual-hierarchy.zh.md)中。
会话页的两个区域作为试点已迁移：对话轮次的证据卡片和 Composer 上方的 Info bar。所有内容均未运行：环境没有 Node，
试点没有经过类型检查、测试或视觉检查，层级是从代码推断的，也没有经过视觉评审。

## 决策

缺口在映射，不在取值。[界面文字角色](../../../../specs/interface-typography.zh.md)禁止并行字号阶梯或新的 token 家族，
所以这一层复用 `text.*` 与 `colors.*`，只增加在它们之间选择的规则。每个界面声明所属层级，层级决定角色、墨色和字重。
规则：字号即角色；相邻角色要有第二处差别；三种墨色；字重表示事物而非状态；每行只用一次强调。

其中两条并不新。侧栏已经因为 11px caption 只比 12px footnote 小 1px 而去掉了它，也已把分组标签由粗体改为 medium
（见[界面打磨](../../implemented/feature/2026-10-16-interface-latin-font-first.md)）。
`components/AGENTS.md` 也已规定置顶会话用图标标记，不用字重。本提案把它们推广，并拿最繁忙的页面检验。

## 试点

Appearance 应当缩放这些字号，这一前提成立：`applyUiFontSize` 只设置 `--ui-font-size`，不改根字号，
所以基于 rem 的 Tailwind `text-xs` 仍是 12px。这是读代码得出的，没有在浏览器里实测。

会话页是最复杂的界面（`session-detail.tsx` 与 `session-chat-interface.tsx` 各约 7,000 行，包含标签栏、Info bar、对话流、
Composer 和带标签的侧面板）。试点取它的两端。

**对话轮次的证据层。** `ai-gui/surface.ts` 中的 `evidenceSurface` 用 StyleX 基于现有 token 表达该层级。
`assistant-edited-files.tsx` 与 `session-file-card.tsx` 原先用阅读字号（14px、常规、`foreground/90`）显示文件名，
卡片因此和上方回答争夺注意力；现在文件名是 13px、500、`label` 墨色，目录、副标题和计数更淡。`view.tsx` 中，
思考标签、计划标签和时间线之外的工具标题由 600 降为 500，运行中的工具动词由 `foreground/90` 改为 `label`。
`ai-gui/AGENTS.md` 规定的「先显示四个路径再展开」和「无逐文件药丸」结构不变。

**文件卡片。** `SessionFileCardLayout` 经三轮渲染重新设计，因为第一版（只改字号和墨色）读者看不出任何变化。
第一轮把它做成物件：带边框卡片里放一张纸和托盘，有三层同心轮廓，违背「用深度而不是线条」。第二轮去掉了这些线条，
仍然不对：托盘、纸张、扩展名、文件名、大小和动作是六个在争夺视线的元素，卡片比它所在的回答更抢眼。
采纳的设计是 `secondaryBackground` 上的一行 44px，没有轮廓和阴影：文件名是唯一的全墨色文字，固定宽度的等宽标签显示扩展名
（固定宽度让文件名在列表中对齐），大小用 `tertiaryLabel`，动作按钮静止时用 `secondaryLabel`，遵循现有注释「更暗的静止色读起来像禁用」。
胶囊方案和两行方块方案也渲染过并被放弃（前者太小，不像交付物；后者只是重复了旧结构）。按文件类型上色被否决：颜色保留给结果。
失败卡片向 `destructive` 偏色；上传中和已过期把标签调暗；较长的状态文字比文件名优先占用宽度，因为那时人需要的是状态，
悬停标题可看全文。有两张效果图是错的并已重做：一处 CSS 顺序错误把扩展名渲染成 9px 而不是代码里的 11px，
动作按钮的静止色在读到现有注释之前用了 `tertiaryLabel`。这对文件卡片重新审视了早先[界面打磨](../../implemented/feature/2026-10-16-interface-latin-font-first.md)
中「一个块只用一种边线」的选择；改动文件卡片保留细线，现在与之不同。`SessionFileCardLayout` 的公开 props 不变，
所以待发送附件行自动采用新样式，`secondaryAction` 插槽由导出的 `SESSION_FILE_CARD_ACTION_CLASS` 提供样式。

**Composer Info bar。** `sessions/info-bar-type.ts` 基于 footnote 与 body 角色导出两个 class 字符串。`info-chip.tsx`、`session-info-chips.tsx`
和 `session-info-bar.tsx` 用它们替换 `text-xs`、`text-sm`、`leading-snug` 和四处 `text-[11px]`。默认字号下 12px 文字不变；
CI 药丸、diff 统计和目标元信息由 11px 变为 12px；目标正文行高约由 19px 变为 20px；大写目标标签字重由 600 变为 500。
这些文字现在全部跟随 Appearance。颜色、间距、高度与行为不变。

## 备选方案

- **直接扩写 `interface-typography.md`，不新建 Spec。** 该 Spec 讲的是缩放与持久化；层级是另一个可单独评审的决策，所以两者互相链接。
- **只在外壳上试点。** 第一版这样做了，读者几乎看不到变化；层级主要体现在对话轮次里，所以试点现在包含它。
- **迁移全部墨色透明度分数。** 推迟。产品调色板中 `label`、`secondaryLabel`、`tertiaryLabel` 分别是 `foreground`、
  `muted-foreground` 和向背景混 30% 的 `muted-foreground`，所以 `/70` 的文字与 `tertiaryLabel` 十分接近
  （本笔记早先写过「映射并不保值」，这是错的）。真正阻止整体迁移的是：54 处使用中混有规则 3 不应触及的图标和分隔线透明度。

## 尚未证实的前提

层级表是我对代码的解读，不是评审过的设计。盘点统计的是 class 用法，只能说明不一致，不能说明页面更难扫读，而且会多算会话页之外的内容。
已有三份 Spec 分别覆盖字号、节奏和菜单字重，评审者完全可以认为这些修复只是合规性修正，不需要映射 Spec。文字本身也不是护栏：
扩展 `tests/e2e/interface-typography.spec.ts`，在五个档位下断言 chip、卡片与标签的计算字号才是（源码 grep 测试不是，仓库会删除这类测试）。

## 验证限制

未运行：本环境只有 darwin 二进制，没有 Node 与 pnpm，因此没有执行 `pnpm check`、`pnpm format`、测试、Storybook 或
`pnpm run docs`。Oxfmt 可能重排已编辑的 `className={cn(...)}`。合并前：运行 `pnpm check` 与 `pnpm format`，运行
`session-info-context-actions.test.tsx`、`assistant-edited-files.test.tsx` 与 `session-file-card.test.tsx`，
并在亮色与暗色、Smaller 与 Larger 字号、长分支名和长目录下查看 `SessionInfoBar`、`AssistantEditedFiles`、`SessionFileCard`
和 `SessionConversationPage` stories。有两点要用眼睛确认：Info bar 的 12px 药丸文字约宽 9%；改动文件卡片「显示更多」的悬停颜色，
因为同一元素上有 Tailwind 的悬停 class 和 StyleX 的基础颜色，而仓库规则说 Tailwind 优先。
文件卡片只作为复现 token 数值的独立效果图渲染过，没有渲染过真实组件；StyleX 的 `when.ancestor` 悬停，
以及固定 40px 的标签在五个 Appearance 字号下的表现都未经验证。请在亮色与暗色、五个字号、长文件名和长上传状态下查看
`SessionFileCard` stories（包括 `IconsByExtension`，现已加入 `Dockerfile` 与 `analysis.ipynb`）和待发送附件行，
并用 Tab 键聚焦一张卡片查看焦点环。亮色下的底色刻意很淡；如果在真实屏幕上看不见，这是第一个要回头看的地方。
Spec 中的盘点数字来自对 `sessions/`、`ai-gui/` 和 `chat/` 的 `grep`，而 `chat/` 含有不属于会话页的落地页与配对界面。
