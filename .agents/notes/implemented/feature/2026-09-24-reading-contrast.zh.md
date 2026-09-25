# 阅读对比度与深色主题亮度上限

Status: implemented
Translation: current

[English](2026-09-24-reading-contrast.md)

## 摘要

在前景为纯白的深色主题中，长时间使用很累：Vesper 里正文、标题、菜单、按钮、设置页和每个侧栏标题都是 #101010 上的
#FFFFFF（19.7:1），笔画产生光晕，密集的中文发虚，也没有任何东西把阅读栏标出来。现在深色主题下所有文字前景都受同一个
亮度上限约束：相对画布 13:1 时的亮度（Vesper 上为 #DDD7CF，仍高于 WCAG AAA）。对话正文比它高一档（15.9:1，#EFEDEB，HSL 亮度 93%），
选中的侧栏行和激活标签页与正文同色，再往上只有标题和粗体；未选中的侧栏文字低于正文。Lody 内置的 Vesper 使用暖色温：
所有中性灰都换成暖白点（画布 #141312），侧栏标题（#C7C3BD）在此基础上手动指定。
高对比度主题不变，浅色主题只限制长文本。

## 决策

- `vscode-theme-css.ts`（`applyReadingBrightness`），深色主题：所有文字前景 token（`--foreground`、card、code、input、
  secondary 与次要按钮、hover、selection、底栏、标签页、侧栏，以及 `--code-added/-removed` 和 `--modified-file`）都向画布
  移动，直到亮度不超过上限，色相保持不变。`--popover-foreground` 和 `--accent-foreground` 由限制后的前景色设置：它们在样式表里
  的默认值是不随主题变化的近白色（`210 40% 96%`），这就是下拉菜单一直发白的原因。
- 允许超过上限的：`--foreground-strong`（17.3:1，标题和粗体）。选中的侧栏行和激活标签页限制在正文这一档：比其他侧栏文字亮，
  但永远不比对话本身亮；选中状态由底色标出。
- 正文和用户气泡用 `--reading-foreground`（15.9:1；Vesper 固定为 #EFEDEB）；未选中的会话标题、分组与项目名、分区标题以及 New chat / Search 用
  `--sidebar-row-foreground`（10.6:1），侧栏永远不比正文亮。悬停只改变行的背景。
- 彩色底上的前景色（`--primary-foreground`、`--destructive-foreground`、highlight 前景色）保持主题值：它们需要的是相对彩色底的对比度。
- 暖色 Vesper（`bundled/vesper-warm-palette.ts`）：在内置主题解析时应用一次，因此应用 token、终端、代码高亮和
  `--vscode-*` 变量一致。所有中性的 workbench 颜色和语法前景色乘以暖白点 (1, 0.976, 0.938)；比 #303030 暗的不透明表面
  提亮 4 级（画布 #101010 → #141312，侧栏 #161616 → #1A1918）。通道向下取整，保证画布与侧栏的层次仍然可见。强调色和纯黑
  保持原值。深色 `--github-draft` 和 Electron 窗口/标题栏颜色使用同一套暖灰。
- `READING_THEME_OVERRIDES` 为 Vesper 指定正文、选中/激活文字（#EFEDEB）和侧栏标题（#C7C3BD），在暖色调色板上手动调定。
- token 之外的字面颜色：深色 Mermaid 配色现在低于上限，绿色合并按钮和 PR 标签页一样使用 `dark:text-background`。
- 行内代码：7% 底色，阅读色文字。列表项间距 0.5rem。大纲定位条静止时为 /32。

## 阅读栏宽度与字体

- 对话列的**内容**宽度上限为 768px（之前是 736px 列宽内的 700px）：`CONVERSATION_CONTENT_WIDTH_CLASS` 在最大宽度上加上
  各断点的左右内边距；大纲定位条的容器阈值从 860px 调到 928px，保持原有的边距。
- 默认无衬线字体栈为 `"PingFang SC", -apple-system, BlinkMacSystemFont, "Hiragino Sans GB", "Microsoft YaHei",
"Helvetica Neue", Arial`，外加 emoji 字体。PingFang SC 是苹果的专有系统字体，不能打包：macOS 和 iOS 使用它，Windows
  回退到 Microsoft YaHei。Inter 仍作为自托管字体保留，供界面字体设置和图表使用。为让所有平台中文字体一致而打包开源字体
  （Noto Sans SC / 思源黑体，SIL OFL）本次未做：需要把数 MB 的字体族按 unicode-range 分片。

## 对话细节

- GitHub 引用：链接文字只是在指代某个 PR 或 Issue 时（URL 本身、`#123`、`repo#123`、`owner/repo#123`、`PR #123`），渲染成
  链接蓝色的小标签 `[图标] owner/repo #123`：PR 或 Issue 图标表明类型（读屏软件也会读出），浅蓝底色（无边框）表明可以点击
  （`github-reference-link.tsx`、`.markdown-reference-chip`）。有自己措辞的链接，或编号与 URL 不符的链接，保持普通链接。
  锚点保留应用内打开 PR 的拦截。
- 表格：线条使用前景色的半透明色（外框和表头分隔线 14%，行、列分隔线 8%），因为主题边框色在画布上几乎看不见；去掉斑马纹。
  不假设任何行或列是标签：所有单元格同一颜色和字重，只有 Markdown 必有的表头行加一条很淡的底色。右上角的复制按钮（悬停或
  键盘聚焦时显示，触屏上常显示）同时复制 HTML 和 Markdown 两种格式（`markdown-table.tsx`）。
- 侧栏底部：设置加一个「更多」菜单（归档，然后是文档、社区、反馈、报告问题）。归档页打开时，「更多」的位置变成退出按钮：
  显示归档图标，悬停时变成返回箭头，点击回到之前的页面（没有历史时回到首页）。激活的底部图标使用 12% 前景色底色（悬停
  16%）；原来的行选中色在 24px 的图标后面几乎看不见。
- 过程行：「Context compacted」和「Retrying…」是过程状态行而不是卡片，因此与「Ran N commands」标题共用同样的行框和间距
  （统一为 34px；之前是 39 / 32px）。
- 信息栏：PR 号用次要文字色，旁边是带颜色的 PR 图标；CI 是结果图标（不再是带底色的「CI」标签）；行数统计放在最右侧带底色的
  小标签里。
- 所有行数统计（+/−）都用 `github-addition` / `github-deletion`，即 PR 的绿色和红色。`--code-added` 仍保留主题的 diff 颜色，
  用于 diff 高亮。
- 侧栏：PR 图标降低饱和度（`saturate(0.55)`，用滤镜而不是透明度）；`Mergeable` 标签是行里唯一需要被注意到的状态，
  使用实底色和半粗体。
- 设置导航：`@lody/ui`（#913）把它改建在 `settings/surface.ts` 上之后，行使用调色板的 `hoverFill` / `selectedFill` 和组件库的
  头像，不再使用本次改动的 10% 选中底色和 18px 账户头像。保留下来的是焦点处理：键盘聚焦的行显示悬停底色而不是强调色描边，
  因为对话框打开时会自动聚焦一行。

## 备选方案

- 默认字号 15px（五档 13–18px，界面比正文小 1px）：实现后在应用里看，15px 的正文显得太大，已撤回。默认仍为 14px，
  五档为 12–16px，界面与正文同一字号。
- 让宽表格和 Mermaid 图以阅读栏为中心超出 768px：实现后在应用里看，内容伸出阅读栏显得奇怪，已撤回。宽内容留在阅读栏内
  （表格横向滚动，图表可全屏查看）。
- 逐个调整各界面（菜单、设置、按钮、面板）：静态扫描显示这些地方没有写死白色，白色来自 token，因此上限应放在主题层，
  所有界面自动继承。
- 修改内置主题文件：这些文件是引入的第三方资源，其他界面也读取原始值；派生 token 只影响文字。
- 用透明度压暗行内图标和头像、悬停时提亮标题：试过后放弃；褪色的图标和头像看起来像被禁用，指针下的颜色变化显得不稳定。
- 为中文收窄到 40em 的阅读栏：本次未做。

## 验证与限制

- `tests/vscode-theme-css.test.ts`：纯白深色主题的 `--foreground`、popover 和侧栏前景不超过 13:1，强调档和激活标签页在
  13 到 17.3:1 之间，侧栏行低于正文；Vesper 解析为暖色（画布 #141312，表面和文字为暖色相，强调色不变）并得到指定颜色；柔和主题和高对比度主题不受影响。`tests/markdown-mermaid-plugin.test.ts`
  检查深色图表文字低于上限。组件测试全部通过。
- 本地生产构建（Vesper）：正文渲染为 #EFEDEB（HSL L 93%，15.9:1）；对对话页、设置页和归档页的可见背景、文字、边框和描边扫描后，没有残留的中性灰或冷灰。
- 只在浏览器里检查了 Vesper。分享图片、终端和彩色底徽章保留各自的颜色。
