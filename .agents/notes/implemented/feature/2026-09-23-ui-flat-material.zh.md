# UI 扁平材质：一盏顶光、清晰的边、不脏

Status: implemented
Translation: current

[English](2026-09-23-ui-flat-material.md)

## 摘要

负责人希望 Lody V2 界面带一点物理质感，整体是扁平的轻拟物，但不能显脏。在 token
board 上看，脏感来自两处。第一，Lody Light 里所有凸起件都是中灰
（`hsl(216 17% 94.3%)`），压在灰色或白色上：tab 的滑块只比轨道亮 6/255，开关
的圆钮是压在强调色上的灰。第二，每个阴影都只有一层柔和模糊，扩散成一团灰雾。
修正的办法是遵循「一盏顶光」的逻辑，而不是去画某种材质。凸起件改成白色，靠
0.5px 发丝边、接触阴影和负扩散的短抬升来区分；凹槽保持凹陷。新增 `sheen`
token 组，在凸起面上叠一层只有几个百分点的光线衰减，按下时去掉。没有加颗粒、
噪点、高光或刻槽，这也符合品牌调研一直以来对写实材质的否定。

## 问题

层级阶梯的结构没问题，光的逻辑不对。一个凸起件如果比它所在的卡片还暗，看起来
就像一块污渍，而不是一个物体；灰色凸起件下面只有一层 1px 2px 的模糊，也就没有
边。次级按钮、tab 滑块、开关圆钮和整个浮层级都是这种情况。popover 阴影
`0 18px 50px / 0.14` 会在每个菜单周围画出一团灰云。

## 品牌调研中的依据

`LodyAI/lody-ui-v2-brand-research` 只作次要参考，相关结论如下：

- 第 11、20、21 轮否定了写实光照、反射、凹槽、颗粒和摄影质感（「我不需要这么
  写实的材质」）。所以这里的物理感只能来自明度、边缘和偏移。
- 调研引用的产品 CSS 本来就偏向「冷调近白画布上的纯白卡片」，并提醒暖奶油色底
  会让白色下拉像是贴上去的。因此保留原有色相（216–225）。
- 纸色、粉蓝与青柠点缀、错位描边纸片只属于品牌层，没有写进 token。

## 决定

- Lody Light 的 `raisedBackground` 改为白色；Vesper 不变。
- 每个抬升阴影都由三层组成：发丝边、接触阴影、负扩散的抬升。Vesper 用 6–10% 的
  白色画发丝边，并保留内侧顶部高光。数值在 `colors.stylex.ts`，规则写在
  `RULES.md#material`。
- `shadow.inkEdge` 增加一层接触阴影，于是墨色和语义色填充（主按钮、破坏性按钮、
  勾选框）是放在表面上，而不是印在表面上。破坏性按钮改为读这个 token，不再写死
  数值。
- 新增 `sheen.raised` 和 `sheen.ink`，通过组件 token 使用（`button.primarySheen`、
  `button.secondarySheen`、`field.checkedSheen`、`field.thumbSheen`、
  `disclosure.indicatorSheen`），并由 `ThemeRoot` 重新声明。
- 按下时，光泽和抬升一起去掉。次级按钮保留发丝边，并加一道一像素的内凹
  （`button.pressedEdge`），否则在白色卡片上一按就看不见了。

## 未采用的方案

- **噪点或颗粒叠层**：这是做出「物理感」最快的办法，但正是负责人在调研里否定过
  的。在 UI 的小尺寸下它读起来就是脏，而脏正是这次要解决的问题。
- **近白页面底配白卡片**：能让浅色模式下的卡片浮起来，但要改动页面 token，而产品
  界面和好几条规则（中性提示的着色、卡片不嵌套）都依赖它。这需要单独决定。
- **提亮 Vesper 的凸起层**：暗色下 tab 滑块（35 对 28）仍然偏弱，目前靠顶部高光
  和发丝边撑住。提亮会打破它和 `selectedFill` 的对应关系，需要单独过一遍 board。

## 验证

- 在 Chromium 里分别截取了改动前后的 Storybook token board
  （`Design System/UI Gallery`，Lody Light 与 Vesper），并在两套配色下逐一目视
  检查了按钮、tab、开关、菜单、对话框和卡片。
- `@lody/ui`：276 个测试通过（`NODE_ENV=development vitest run`），
  `tsc --noEmit` 无报错。gallery 测试现在也要求每个 `sheen` token 都出现在 board
  上。
- 局限：仍在使用 Tailwind token 的产品界面不受影响。验证只覆盖了 board 和已经迁移
  到 `@lody/ui` 的调用方，尚无人工视觉确认。
- Storybook preview 之前还在引用已删除的 Radix `src/ui/tooltip`，导致所有 story
  都加载失败；现已改用 `@lody/ui/tooltip` 的 `Tooltip.Provider`。

相关：[token gallery](2026-09-09-ui-token-gallery.md)、
[调用点迁移](2026-09-22-ui-radix-callsite-migration.md)。
