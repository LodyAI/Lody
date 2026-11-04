# Lody Light 的中性灰

Status: implemented
Translation: current

[English](2026-10-17-neutral-light-grays.md)

## 摘要

Lody Light 的侧栏填充、文字、分隔线、阴影和共享浅色灰阶带有蓝色色相，而页面与抬高表面已经是中性灰。相邻区域亮度接近、色相不同，界面因此显得不统一。现在，内置主题、UI 调色板和 CSS 回退中的中性灰都保持原有 HSL 亮度并将饱和度设为零；蓝色强调色和 Vesper 深色调色板继续保留原有颜色。代码配色已做静态核对，但尚未进行实际界面截图检查。

## 发现

内置 `lody-light.json` 提供当前侧栏和工作台颜色：侧栏为 `#EFEFF1`、悬停为 `#E0E0E4`、选中为 `#DCDBE1`、边框为 `#C9CDD6`、正文色为 `#1A1B1E`。UI 浅色调色板和 Tailwind 未加载主题时的回退值也使用了带蓝色的 HSL 灰。首帧启动壳另有一份 HSL 配色，因此只改解析后的主题会让初始侧栏和状态文字仍然偏色。

## 决策

移除浅色主题中中性灰的色度，同时保留 HSL 亮度。这样保留现有界面层级和选中行深度，让相邻灰阶使用同一中性色相。例如，内置主题中的上述颜色变为 `#F0F0F0`、`#E2E2E2`、`#DEDEDE`、`#D0D0D0` 和 `#1C1C1C`。

同样更新 `@lody/ui` 浅色调色板、灰阶与阴影墨色、Tailwind 浅色回退值（包括 task surface）以及启动壳。保留蓝色链接和主要操作、表达蓝色状态的语法与选中色，以及 Vesper 深色调色板。这样保留 Lody 自己的强调色和深色外观，不需要照搬另一个产品的整套配色。

## 证据

- 当前浅色主题通过 `lib/vscode-theme/vscode-theme-css.ts` 将 `sideBar.background`、列表悬停与选中色、侧栏边框和文字映射到应用 CSS token。
- `lody-ui-palette.stylex.ts` 应用产品浅色语义调色板；共享灰阶定义在 `packages/ui/src/tokens/colors.stylex.ts`。
- `BOOT_SHELL_COLORS.light` 提供渲染前的侧栏、边框和状态色，并应与内置主题一致。
- 有意表达状态的蓝色编辑器栈帧高亮仍保持蓝色；语义语法色和操作色也不按灰色处理。

## 验证与限制

`tests/boot-shell.test.tsx` 会检查首帧硬编码的画布、侧栏、侧栏边框和状态文字颜色是否与内置主题解析值一致。启动壳、侧栏徽标与工作区侧栏的定向测试均通过。主题在实际界面中的效果和对比度仍需截图检查。
