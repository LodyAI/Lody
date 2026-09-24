# 阅读对比度与深色主题亮度上限

Status: implemented
Translation: current

[English](2026-09-24-reading-contrast.md)

## 摘要

在前景为纯白的深色主题中，长时间使用很累：Vesper 里正文、标题、菜单、按钮、设置页和每个侧栏标题都是 #101010 上的
#FFFFFF（19.7:1），笔画产生光晕，密集的中文发虚，也没有任何东西把阅读栏标出来。现在深色主题下所有文字前景都受同一个
亮度上限约束：相对画布 11.6:1 时的亮度（Vesper 上为 #D2CDC5，仍高于 WCAG AAA）。对话正文比它高一档（14.2:1，#E4E1DD，HSL 亮度 88%），
再往上只有标题和粗体、选中的侧栏行和激活标签页；未选中的侧栏文字低于正文。Lody 内置的 Vesper 使用暖色温：所有中性灰都换成暖白点（画布 #141312），侧栏
（#BAB6AE）和选中/激活文字（#F0EAE1）在此基础上手动指定。
高对比度主题不变，浅色主题只限制长文本。

## 决策

- `vscode-theme-css.ts`（`applyReadingBrightness`），深色主题：所有文字前景 token（`--foreground`、card、code、input、
  secondary 与次要按钮、hover、selection、底栏、标签页、侧栏，以及 `--code-added/-removed` 和 `--modified-file`）都向画布
  移动，直到亮度不超过上限，色相保持不变。`--popover-foreground` 和 `--accent-foreground` 由限制后的前景色设置：它们在样式表里
  的默认值是不随主题变化的近白色（`210 40% 96%`），这就是下拉菜单一直发白的原因。
- 允许超过上限的：`--foreground-strong`（15:1，标题和粗体），以及选中侧栏行和激活标签页的前景色（同样限制在 15:1 这一档）。
- 正文和用户气泡用 `--reading-foreground`（14.2:1；Vesper 固定为 #E4E1DD）；未选中的会话标题、分组与项目名、分区标题以及 New chat / Search 用
  `--sidebar-row-foreground`（9.2:1），侧栏永远不比正文亮。悬停只改变行的背景。
- 彩色底上的前景色（`--primary-foreground`、`--destructive-foreground`、highlight 前景色）保持主题值：它们需要的是相对彩色底的对比度。
- 暖色 Vesper（`bundled/vesper-warm-palette.ts`）：在内置主题解析时应用一次，因此应用 token、终端、代码高亮和
  `--vscode-*` 变量一致。所有中性的 workbench 颜色和语法前景色乘以暖白点 (1, 0.976, 0.938)；比 #303030 暗的不透明表面
  提亮 4 级（画布 #101010 → #141312，侧栏 #161616 → #1A1918）。通道向下取整，保证画布与侧栏的层次仍然可见。强调色和纯黑
  保持原值。深色 `--github-draft` 和 Electron 窗口/标题栏颜色使用同一套暖灰。
- `READING_THEME_OVERRIDES` 为 Vesper 指定侧栏（#BAB6AE）和选中/激活文字（#F0EAE1），在暖色调色板上手动调定。
- token 之外的字面颜色：深色 Mermaid 配色现在低于上限，绿色合并按钮和 PR 标签页一样使用 `dark:text-background`。
- 行内代码：7% 底色，阅读色文字。列表项间距 0.5rem。大纲定位条静止时为 /32。

## 阅读栏宽度与字体

- 对话列的**内容**宽度上限为 768px（之前是 736px 列宽内的 700px）：`CONVERSATION_CONTENT_WIDTH_CLASS` 在最大宽度上加上
  各断点的左右内边距；大纲定位条的容器阈值从 860px 调到 928px，保持原有的边距。
- 默认无衬线字体栈为 `"PingFang SC", -apple-system, BlinkMacSystemFont, "Hiragino Sans GB", "Microsoft YaHei",
"Helvetica Neue", Arial`，外加 emoji 字体。PingFang SC 是苹果的专有系统字体，不能打包：macOS 和 iOS 使用它，Windows
  回退到 Microsoft YaHei。Inter 仍作为自托管字体保留，供界面字体设置和图表使用。为让所有平台中文字体一致而打包开源字体
  （Noto Sans SC / 思源黑体，SIL OFL）本次未做：需要把数 MB 的字体族按 unicode-range 分片。

## 备选方案

- 逐个调整各界面（菜单、设置、按钮、面板）：静态扫描显示这些地方没有写死白色，白色来自 token，因此上限应放在主题层，
  所有界面自动继承。
- 修改内置主题文件：这些文件是引入的第三方资源，其他界面也读取原始值；派生 token 只影响文字。
- 用透明度压暗行内图标和头像、悬停时提亮标题：试过后放弃；褪色的图标和头像看起来像被禁用，指针下的颜色变化显得不稳定。
- 为中文收窄到 40em 的阅读栏：本次未做。

## 验证与限制

- `tests/vscode-theme-css.test.ts`：纯白深色主题的 `--foreground`、popover 和侧栏前景不超过 11.6:1，强调档和激活标签页在
  11.6 到 15:1 之间，侧栏行低于正文；Vesper 解析为暖色（画布 #141312，表面和文字为暖色相，强调色不变）并得到指定颜色；柔和主题和高对比度主题不受影响。`tests/markdown-mermaid-plugin.test.ts`
  检查深色图表文字低于上限。组件测试全部通过。
- 本地生产构建（Vesper）：正文渲染为 #E4E1DD（HSL L 88%，14.2:1）；对对话页、设置页和归档页的可见背景、文字、边框和描边扫描后，没有残留的中性灰或冷灰。
- 只在浏览器里检查了 Vesper。分享图片、终端和彩色底徽章保留各自的颜色。
