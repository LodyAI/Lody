# 将共享会话控件样式收归 StyleX

Status: implemented
Translation: current
PR: [#1017](https://github.com/LodyAI/Lody/pull/1017)

[English](2026-09-26-session-controls-stylex.md)

## 摘要

工作目录模式选择器、行内 worktree 勾选项和会话关系卡仍通过 Tailwind 类定义自身外观。现在这些视觉规则由各组件本地的 StyleX 定义负责；窄菜单宽度改为 `@lody/ui` 正式的 compact 变体，不再覆盖基础组件的 class。只读模式改为非交互文本，而不是禁用按钮。明暗主题下 32 个固定 Playwright 场景的前后截图均为零像素差异；该结果只覆盖抽样状态，不代表所有宿主与显示倍率。

## 决策

会话关系卡负责自身的行、图标、截断和悬停样式；工作目录文件负责选择器内容与勾选 pill。chat landing composer 使用 pill 的显式 `surface="context"` 变体，不再传入 Tailwind 视觉覆盖。二者使用 `@lody/ui` 映射到产品主题的文字与分隔色 token。原有的 `--muted` 和 `--hover` 薄膜尚无像素等价的语义 token，因此在设计出对应 token 前，StyleX 声明内保留精确的主题 CSS 变量。没有等价值的圆角与水平内边距也保留实测像素。这是局部兼容桥接，并非新增调色板。

可交互选择器继续使用 `@lody/ui` 的 Button 和 Menu。原来的 180px 菜单下限是对基础组件默认 200px 宽度的 Tailwind 覆盖；现在由可复用的双选项变体 `Menu.Content width="compact"` 负责，内容较长时仍可扩展。旧的禁用 Button 被 Tailwind 覆盖为 80% 不透明度，与基础组件的 45% 禁用规则冲突。会话创建后模式已锁定，此标签不是操作，因此使用带 tooltip 名称的非交互 span，保留 80% 外观，同时去掉误导性的键盘停靠点。该选择延续[菜单组件决策](../feature/2026-09-11-ui-menu-primitives.md)，无需由调用方重设基础组件样式。

## 验证

Playwright 在同一 Storybook fixture 中对 Tailwind 原版和 StyleX 新版截图：800 × 760、设备倍率 1、字体加载完成、减少动效、关闭动画，并重复截图直至稳定。32 组明暗场景覆盖菜单关闭与打开、选择 Worktree、不可用与只读模式、独立及 composer context 中选中和禁用的 pill、独立关系卡和会话内关系卡。每组 RGBA 像素差异均为零。含 ACP 依赖的验证检出中，UI 和 components typecheck 通过；`@lody/ui` 全套 297 个测试和关系卡的 9 个测试通过。主 worktree 未检出 ACP 子模块，因此其组件 typecheck 和仓库级检查无法证明全绿；本 PR 的完整检查以 GitHub CI 为准。
