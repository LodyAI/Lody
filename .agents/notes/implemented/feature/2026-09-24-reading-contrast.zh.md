# 阅读对比度与深色主题亮度上限

Status: implemented
Translation: current

[English](2026-09-24-reading-contrast.md)

## 摘要

在前景为纯白的深色主题中，长时间使用很累：Vesper 里正文、标题、菜单、按钮、设置页和每个侧栏标题都是 #101010 上的
#FFFFFF（19.7:1），笔画产生光晕，密集的中文发虚，也没有任何东西把阅读栏标出来。现在深色主题下所有文字前景都受同一个
亮度上限约束：相对画布 13:1 时的亮度（Vesper 上为 #D5D5D5，仍高于 WCAG AAA）。只有标题和粗体、选中的侧栏行和激活标签页
可以超过它；未选中的侧栏文字低于正文。Vesper 的侧栏（#BCBAB8）和选中/激活文字（#F0EFED）使用手动指定的暖灰。
高对比度主题不变，浅色主题只限制长文本。

## 决策

- `vscode-theme-css.ts`（`applyReadingBrightness`），深色主题：所有文字前景 token（`--foreground`、card、code、input、
  secondary 与次要按钮、hover、selection、底栏、标签页、侧栏，以及 `--code-added/-removed` 和 `--modified-file`）都向画布
  移动，直到亮度不超过上限，色相保持不变。`--popover-foreground` 和 `--accent-foreground` 由限制后的前景色设置：它们在样式表里
  的默认值是不随主题变化的近白色（`210 40% 96%`），这就是下拉菜单一直发白的原因。
- 允许超过上限的：`--foreground-strong`（16:1，标题和粗体），以及选中侧栏行和激活标签页的前景色（同样限制在 16:1 这一档）。
- 正文和用户气泡用 `--reading-foreground`；未选中的会话标题、分组与项目名、分区标题以及 New chat / Search 用
  `--sidebar-row-foreground`（11.3:1），侧栏永远不比正文亮。悬停只改变行的背景。
- 彩色底上的前景色（`--primary-foreground`、`--destructive-foreground`、highlight 前景色）保持主题值：它们需要的是相对彩色底的对比度。
- `READING_THEME_OVERRIDES` 为 Vesper 指定侧栏（#BCBAB8）和选中/激活文字（#F0EFED）：这些暖灰无法从它的中性调色板推算出来。
- token 之外的字面颜色：深色 Mermaid 配色现在低于上限，绿色合并按钮和 PR 标签页一样使用 `dark:text-background`。
- 行内代码：7% 底色，阅读色文字。列表项间距 0.5rem。大纲定位条静止时为 /32。

## 备选方案

- 逐个调整各界面（菜单、设置、按钮、面板）：静态扫描显示这些地方没有写死白色，白色来自 token，因此上限应放在主题层，
  所有界面自动继承。
- 修改内置主题文件：这些文件是引入的第三方资源，其他界面也读取原始值；派生 token 只影响文字。
- 用透明度压暗行内图标和头像、悬停时提亮标题：试过后放弃；褪色的图标和头像看起来像被禁用，指针下的颜色变化显得不稳定。
- 整个主题加暖色调，或为中文收窄到 40em 的阅读栏：本次未做。

## 验证与限制

- `tests/vscode-theme-css.test.ts`：纯白深色主题的 `--foreground`、popover 和侧栏前景不超过 13:1，强调档和激活标签页在
  13 到 16:1 之间，侧栏行低于正文；Vesper 得到指定颜色；柔和主题和高对比度主题不受影响。`tests/markdown-mermaid-plugin.test.ts`
  检查深色图表文字低于上限。组件测试全部通过。
- 本地生产构建（Vesper）：除三个允许的例外外，所有前景 token 都不超过 #D5D5D5；对页面可见文字的整体扫描没有发现其他超过上限的文字。
- 只在浏览器里检查了 Vesper。分享图片、终端和彩色底徽章保留各自的颜色。
