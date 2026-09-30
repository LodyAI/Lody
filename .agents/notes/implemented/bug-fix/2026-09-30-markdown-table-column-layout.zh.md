# 按 hast 分类 Markdown 表格列，短单元格不再被迫换行

Status: implemented
Translation: current

[English](2026-09-30-markdown-table-column-layout.md)

## 摘要

会话里的 Markdown 表格曾有两种相反方向的坏渲染：`w-full` 让只有少量内容的
小表格撑满整行；而含长不可断内容（不换行的 `AgentFileLink` chip 里的文件路径）
的单元格会把所在列的 min-content 撑成整条路径的宽度，把后面的列挤到只剩几个
字符。修复方式是在渲染时根据 hast 对每列分类：所有单元格都不超过约 24 个半宽
单位的列按自然宽度保持单行；含有超过该长度 token 的列允许在 token 内部断行
（`overflow-wrap: anywhere`），并以 `max-width: 20em` 封顶——上限压低了该列的
max-content 贡献，auto layout 的按比例分配就无法让它饿死散文列；其余列在 em
下限（`min-width`）之上按词间换行，而最宽行本来就宽的列享有更高的下限，即使
所有列的下限之和已超过容器也能保持可读宽度。估算值还写入 `<col>` 偏好宽度：
Chromium 在空间充足时精确采用指定列宽、不足时按超出 min-content 的比例收缩，
拥挤表格因此按需求比例分配宽度，而不是把每列都钉在下限上。外框改为 `w-fit
max-w-full`，小表格收缩到内容宽度，真正宽的表格在边框内横向滚动。手机宽度下
放弃单行规则——480px 面板仍保留它，但手机上 nowrap 列会挤占其他所有列。

## 问题

两个表面症状，同一类根因：

- 表格是 `w-full`，浏览器在 auto layout 下把列拉伸填满，小表格的大部分
  单元格几乎全空。
- 单元格里出现长路径或 URL 时，`AgentFileLink` 的 `truncate`（即
  `white-space: nowrap` 加省略号）把该列 min-content 定成整条路径。auto
  layout 随之饿死其余列，每行只剩一两个字符，或溢出滚动框。

先试过对所有单元格用 `overflow-wrap: anywhere`，被否决：它把每列的
min-content 缩到单字符，按比例分配后短列反而被压垮，手机上还会把普通单词
从中间断开。CJK 文本也不能按一个 "token" 计算——每个宽字符本身就是断行
机会——所以不可断 token 的度量要在空白**和**宽字符上都做切分。

## 决定

- `markdown-table.tsx` 的 `markdownTableColumnLayout` 遍历表格 hast
  （react-markdown 经 `ExtraProps['node']` 传入；GFM 表格无合并单元格，
  单元格的行内位置即列号）。按列记录最宽行（`<br>` 分行）与最宽不可断
  token 的估算 em 宽（CJK/全角/emoji 计 1，窄字符计 0.55；`img`/`video`
  按约 22em 的单 token 计，使图片列与路径列一样被分类和约束）。
  `MARKDOWN_TABLE_ONE_LINE_EM = 13`、`MARKDOWN_TABLE_WIDE_EM = 16`、
  `MARKDOWN_TABLE_MAX_COL_EM = 30`。
- `<table>` 输出 `data-one-line-columns` / `data-break-anywhere-columns` /
  `data-wide-columns` 词表属性，并渲染 `<colgroup>`，各 `<col>` 宽度为内容
  估算值（30em 封顶）。`src/tailwind/index.css` 用静态 `:nth-child` 选择器
  （第 1–24 列）把标记落成 `white-space: nowrap`（min-width 0）、
  `overflow-wrap: anywhere` + `max-width: 20em`，以及更高的 `min-width`
  下限（9em；视口超过 640px 时 15em）。所有单元格带 `min-width` 下限——
  5em，宽视口 8em——任何列都不会被压成窄条。
- 两个上限都是必要的：Chromium 按各列 max-content 减 min-content 的比例
  分配富余宽度，一条 500px 的不可断路径即使已折行也会拿走大部分余量；
  而当所有列都已压到下限时，宽列需要更高的下限才不会退化到一行一个字。
- 单元格内的 `AgentFileLink`（`[:is(th,td)_&]` 变体）改为 inline 流：图标用
  inline-block，label 继承单元格 `white-space` 并加 `line-break: anywhere`，
  折行的路径不会让文件图标孤立成行。
- 已考虑的替代方案：在滚动框上用 CSS container query 会让 shrink-to-fit 祖先
  塌陷（Markdown 渲染在气泡等 fit-content 容器里）；布局后实测宽度会在流式
  token 到达时反复重算，且仍需同样的分类策略。hast 启发式是确定性的、SSR
  安全；分类随每次渲染重算，流式表格可能随单元格到达重排一次，与任何内容
  驱动的宽度一致。

## 验证

- `tests/markdown-streaming-reparse.test.ts` 在静态与流式两条渲染路径上都
  断言了渲染后表格的列分类属性（上面的 CJK token bug 即由该测试抓到）。
- `src/stories/MarkdownTables.stories.tsx`（Conversation/Markdown tables）
  覆盖十二个场景——所报的状态汇报表、短键值表、散文单元格、混排行内元素、
  数字表、多列表、长不可断 token、超长散文单元格、含图片单元格、16×40
  网格、14×24 复杂混排——在 720/480/360px、深浅两主题下用 Playwright
  截图复核。

未验证：低于 story 视口的真机宽度，以及 CJK 字形显著偏离 2:1 的字体。
