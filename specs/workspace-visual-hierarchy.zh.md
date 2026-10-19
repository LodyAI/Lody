# 工作台视觉层级

Status: draft
Translation: current

[English](workspace-visual-hierarchy.md)

## 摘要

[界面文字角色](interface-typography.zh.md)确定了字号角色，[对话节奏](conversation-rhythm.zh.md)确定了间距，
但都没有规定哪类内容用哪个角色、墨色和字重。会话页是产品里最繁忙的界面，这个选择由各组件自行决定，
已经出现漂移。本草案为 Coding Agent 工作台命名五个内容层级和五条约束规则，不新增字体、字号阶梯或 token 家族。
试点是 Composer 上方的 Info bar；页面其余部分只做了度量，未迁移。本文未获批准。

## 场景

一个会话里 Agent 已经工作了十分钟，用户回来查看。他们先要找到答案，然后是改了什么、是否通过，
只有在看起来不对时才需要看 Agent 是怎么做的。层级就是页面让人不必通读全部内容、就能按这个顺序找到它们的方式。

## 层级

每个层级把一类内容映射到已有角色。界面选择层级，而不是自己选字号、灰度或字重。

| 层级               | 内容                                     | 角色                                | 墨色                             | 字重     |
| ------------------ | ---------------------------------------- | ----------------------------------- | -------------------------------- | -------- |
| 阅读（Reading）    | 用户消息、Agent 回答                     | body，阅读行高                      | `reading`                        | 400      |
| 证据（Evidence）   | 改动文件、计划、PR 与 CI 结论、diff 统计 | subheadline                         | `label`；仅结果可用色相          | 名称 500 |
| 过程（Process）    | 思考、工具调用、进度说明                 | subheadline                         | `secondaryLabel`                 | 400      |
| 元数据（Metadata） | 时间、耗时、模型、作者                   | 对话中为 caption，其他处为 footnote | `secondaryLabel`                 | 400      |
| 外壳（Chrome）     | 标签栏、Info bar、Composer 控件          | footnote 或 subheadline             | `secondaryLabel`，悬停为 `label` | 控件 500 |

只有阅读层使用完整的阅读墨色，暗色主题已经把它压在其他文字之上。证据层是唯一可以带色相的层级，
因为那里的色相报告的是结果，而不是操作。

## 规则

1. **字号即角色。** 产品文字不使用 Tailwind 字号工具类，也不写固定像素值。这已经是 interface-typography 的规则；
   下面的盘点表明本页尚未做到。
2. **相邻角色要有两处不同。** 相差 1px 的两个角色只有在墨色或字重也不同时，才可以出现在同一张卡片或同一行，
   例如侧栏 13px 的行与 12px 的分组标签。caption（11）与 footnote（12）并排时没有其他差别，
   所以侧栏去掉了 caption，Info bar 沿用。
3. **三种墨色。** `label`、`secondaryLabel`、`tertiaryLabel`，其上是阅读墨色。foreground 的透明度分数（`/70`、`/85`）不算第四种墨色。
4. **字重表示事物，不表示状态。** 正文、过程与菜单标签 400；名称、标签与控件 500；外壳不超过 500。状态用图标或强调色表示，
   如置顶会话。
5. **每行只用一次强调。** 一行用位置、墨色一档或强调色中的一种标记状态，不叠加字重与色相。

## 试点

会话页的两个区域，分处层级的两端。

**对话轮次的证据层。** 改动文件卡片和文件卡片原先用阅读字号（14px、常规字重、`foreground/90`）显示文件名，
卡片因此和上方的回答争夺注意力。现在文件名是 subheadline 角色、500、`label` 墨色；目录用 `tertiaryLabel`；
副标题、计数和卡片标题用 footnote；diff 计数保留色相。过程层中，思考标签、计划标签以及时间线之外的工具标题由 600 降为 500，
运行中的工具动词由 `foreground/90` 改为 `label`。这些是肉眼可见的变化。

**文件卡片。** 它是被重新设计的，不只是换了样式。在这一版之前渲染并否决了两次：带边框卡片里放纸张和托盘
（三层同心轮廓；去掉轮廓后仍有六个元素在争夺视线），卡片因此比上方的回答更抢眼。现在的卡片是一行 44px，
只有一层底色，没有轮廓和阴影：文件名是唯一的全墨色文字，扩展名、大小和动作各低一档。证据因此安静地待在回答下面，
而不是从页面上凸起来。改动文件卡片保留着旧的细线，成了不一致的那一个。

**Composer Info bar。** 原先有 12px 的 chip、11px 的药丸、14px 的正文弹层和 11px 半粗大写标签。现在整体使用 footnote 角色，
仅目标正文使用 body 角色。默认字号下 12px 文字不变；CI 药丸、diff 统计和目标元信息由 11px 变为 12px；并开始跟随 Appearance。

阅读正文、间距、高度、结构与行为均未改动。

## 尚未证实的前提

- **层级是从代码推断的。** 还没有人对照渲染后的页面审视过。盘点统计的是 class 用法，只能说明不一致，
  不能说明读者更难扫读页面。
- **盘点会多算。** `chat/` 含落地页和配对界面，54 处墨色分数中有一部分是图标或分隔线透明度。
- **现有 Spec 可能已经够用。** 角色、节奏和菜单字重都已有规定。只有评审者希望把「内容到角色」的映射写下来，
  本草案才有存在价值；否则这些修复可作为对[界面文字角色](interface-typography.zh.md)的合规性修正单独成立。
- **文件卡片的安静程度未经检验。** 它来自「先看回答、后看证据」的阅读顺序；没有更强的卡片，人能否足够快地找到交付的文件尚不清楚。
  改动文件卡片和工具详情面板还没有对照过。
- **文字不是护栏。** 这里没有任何东西能阻止下一个 `text-xs`。能阻止的是在五个字号档位下检查计算字号的浏览器测试，
  可以扩展现有回归。

## 盘点

试点前统计 `components/{sessions,ai-gui,chat}`：

- 164 处产品文字字号不跟随 Appearance：116 处 `text-xs`、`text-sm` 或 `text-base`，48 处任意值（27 处 `text-[11px]`，11 处 `text-[10px]`）。
- 54 处墨色透明度分数，共 12 种取值，而墨色只有三档。
- 字重：79 处 `font-medium`，14 处 `font-semibold`，11 处 `font-normal`。

## 未决问题

- 54 处透明度分数中哪些是文字，哪些是规则 3 不应触及的图标或分隔线透明度。产品调色板中 `label`、`secondaryLabel`、
  `tertiaryLabel` 分别是 `foreground`、`muted-foreground` 和向背景混 30% 的 `muted-foreground`，
  所以 `/70` 的文字与 `tertiaryLabel` 十分接近。
- `tertiaryLabel` 用于目录路径是否足够清晰；它就是原来的 `/70`。
- 外壳是否保留 600；14 处使用与 `@lody/ui` 的 6 处声明尚未审查。
- 证据层的名称是否在所有位置都用 `label` 墨色，包括 Markdown 文件链接。
- 移动端：未审计任何移动端界面。

## 证据

- 意图：本文，位于上述两份 Spec 之上。
- 已检查：[证据层样式](../packages/components/src/components/ai-gui/surface.ts)、[Info bar 字号](../packages/components/src/components/sessions/info-bar-type.ts)、
  [角色 token](../packages/ui/src/tokens/scales.stylex.ts)、
  [侧栏先例](../.agents/notes/implemented/feature/2026-10-16-interface-latin-font-first.md)。
- 已执行：无。环境没有 Node，未运行类型检查、测试或视觉检查。
- 决策：[工作台层级笔记](../.agents/notes/proposed/architecture/2026-10-16-workspace-visual-hierarchy.zh.md)。
