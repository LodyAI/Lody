# 设置页节奏、被裁掉的卡片边缘，以及输入框图片预览卡片

Status: implemented
Translation: current

[English](2026-09-25-settings-rhythm-and-image-peek.md)

## 摘要

Owner 认为桌面端设置页拥挤、凌乱、读起来难受。两轮放宽间距都因臃肿被否决；真正的原因
在字体和材质：设置文字最小到 9.8px、行高 1.25，中文糊成一团；标题字号因嵌套放大成 20.6px
与 18px 两种；同一行内 400/500/600 字重混用；每个分组都是白色面板上的白卡片，只靠阴影
光晕区分。现在设置页有统一字阶（12px 下限、1.45 行高、两种字重加半粗标题），材质从四个
实际渲染的方案中选定：导航、中性灰画布、画布上的白卡片三层，用底色而非线条区分。紧贴
滚动容器顶部的卡片丢失上边缘的问题已修复；输入框的图片灯箱改为从缩略图弹出的 popover
卡片。同一改动中 tooltip 也不再反色，该决定记录在
[overlay primitives 笔记](2026-09-12-ui-overlay-primitives.md)。

## 设置页的字体与材质

**字体为什么难受。** 字体是内置的 Inter，中文回退到系统字体（或用户选择的界面字体），
问题不在字体本身。按默认 14px 在 Chromium 中实测：分组与导航标题 10.5px，说明文字
11.2px，目录元信息 9.8px，标签与说明行高 1.25。页面标题在设置浮层里是 20.6px（对话框
16px 的 `h2` 里用了 `1.286em`），在项目页是 18px。同一行里标签 14px、按钮 13px、分段
控件 12px。字重混用 400、500、600，而中文回退到 PingFang，它的 Medium 和 Semibold 比
Inter 重得多，600 的标题读起来像一块黑。

**字阶。** `settings/type.stylex.ts` 用 `--ui-font-size` 而不是 `em` 计算所有字号，
因此不会叠加：`caption`（12px）是下限，`title`（18px）用于页面标题，`leading`（1.45）
用于任何堆叠的文字。两种字重：标签、说明、数值用常规字重，分组标题用 `headingWeight`
（500）；只有页面标题用 `titleWeight`（600）。控件沿用 `@lody/ui` 的 13px/500，设置页
自带的分段控件也改成了这一规格。行高变大的地方，行内边距由 10px 改为 8px。

**材质：从四个方案中选定。** Owner 要求参考 Notion 从零重新设计。先做了平铺文档版
（标题压细线、行分隔、无卡片），再与三个备选方案一起在四个页面、两种配色下实际渲染对比：
冷蓝灰的平铺文档；灰底白卡（macOS 分组设置）；平铺配 Notion 的暖中性色；平铺并在每组
后面加一层很淡的托盘。平铺方案在浅色下显得冷、过于扁平——只剩白色、97.5% 的蓝灰导航和
蓝灰细线——也背离了 `@lody/ui` 整体“略有物理感”的材质。Owner 选择了灰底白卡。浮层只靠三层底色区分：`surface.nav`（页面背景向黑色混合 6.5%）、
`surface.canvas`（抬升层底色向黑色混合 3.5%，浅色下是中性灰）、`surface.card`（凸起层
底色加卡片层级的细描边和贴地阴影）。三层都由 token 推导，因此在深色和强制配色下顺序不变；
深色配色里 `secondaryBackground` 与 `elevatedBackground` 同为 8.6%，所以最初的平铺版在
深色下导航与内容完全没有区分。行分隔线以及导航行的悬停、选中底色都改为墨色叠加，因为
配色里的 `hoverFill` 和 `selectedFill` 在灰色导航上几乎看不见。导航宽 240px；208px 时
与内容相比显得局促。之后曾有一轮把导航改成纯白面板、把画布移到页面背景之下并收窄内容栏，
被否决：它改了没人要求改的底色，也打乱了层级阶梯的顺序，已回退到选定的三层方案。
页面标题用 `surface.pageTitle`，
位于与内容相同的居中 760px 栏内；项目页去掉了旧双栏布局遗留的 1152px 宽栏。

卡片层级的阴影（`shadow.card`）去掉了抬升层。原来是细描边、贴地阴影加
`0 8px 24px -6px`；设置页上层叠的卡片被宽模糊画出一圈光晕，轮廓读起来像每块后面还有
一层。卡片是放在页面上的，所以现在两种配色下都只保留细描边和短的贴地阴影。

## 被裁掉的卡片边缘

设置卡片没有 border，它的边缘是 `shadow.card` 的第一层（`0 0 0 0.5px`），而
滚动容器（`overflow: auto`）会裁掉 padding box 之外的一切。项目窗口里的
`pageBody` 可滚动且没有上内边距，所以作为页面第一个元素的卡片丢了上边缘。本地
项目碰巧没暴露问题，因为它前面有一条离线提示；GitHub 项目的第一个子元素就是卡片。
现在滚动容器有 4px 上内边距，上方的描述相应少 4px。GitHub 项目窗口的前后截图
复现并确认修复了这一缺陷。

## 输入框图片预览卡片

点击输入框缩略图原本会打开一个模态 `Dialog`，图片最宽 `max-w-3xl`，盖住正在写的
草稿。`ComposerImagePeek`（`components/chat/composer-image-peek.tsx`）改用锚定在
缩略图上的 `@lody/ui` Popover。卡片显示图片（最大 480×360，并受可用空间限制）、
文件名，以及加载后的原始尺寸——尺寸是缩略图唯一无法表达的信息。

打开时以弹簧动画从缩略图（`--transform-origin`）放大，带轻微过冲；关闭时是
150ms 的普通 ease-out。弹簧复用现有的 `springLinear`，编译为 CSS `linear()`
曲线，通过 positioner 上的自定义属性传入。用 CSS transition 可以保留 Base UI 的
关闭生命周期：Base UI 会等待 popup 上正在运行的 transition 结束后再卸载。
Framer Motion 弹簧则需要 `keepMounted`、`AnimatePresence`，以及绕开 `@lody/ui`
直接使用 Base UI popup。`springLinear` 采样 1.2s，因此打开的 transition 也是
1.2s，以保持曲线形状；视觉上大约 350ms 后就已静止。

## 第二轮评审：GitHub 页、badge、侧边栏菜单、后台任务

**GitHub 设置页从零重做。** 原页面是层层灰盒：一个着色图标方块写着 “GitHub App”，
灰盒里再套一个灰色凹槽只放 `@login`，每个仓库前都有书本图标，滚动页面里还有一个
滚动框。现在三个问题各由拥有它的表面回答（`github-settings-view.tsx`，纯 props 视图，
配 `Settings/GitHubSettings` stories）。App 行的说明就是安装状态（“5 个仓库中已启用
3 个”“尚未安装”），旁边是管理按钮。开启“以个人身份操作”后，说明行直接写出账号（头像
加 `@login`），未授权时变为警告，并在开关旁出现“授权”。仓库按 owner 分组，每组一张卡片、
自带已启用计数；每行只有仓库名、私有时的锁形图标和开关。超过 5 个仓库才出现搜索。
空、加载中、无匹配三种状态使用目录的安静区域和卡片备注。
`GitHubPersonalIdentitySettingsCard` 现在只作为移动端详情面板。

**Badge。** Owner 问到的成员角色和机器共享标签本来就是 `Badge`。手写的在别处，共
18 处：侧边栏的同步与可合并标签、Worktree/Imported/Conflict/Draft 小标签、移动端
成员角色，以及若干通过 `className` 改写 `Badge` 样式的调用。现在全部改为 `Badge`，
状态用 tone 表达。私有仓库用锁形图标而非 badge，因为每行重复一个标签只是噪音。

**侧边栏视图菜单。** 高度从约 196px 涨到了 254px：Popover 面板的 gap 在每个分区之间
插入 8px，分组标题占满 28px 一行，分隔线上下各 4px。侧边栏菜单现在在本地覆盖这些值：
无 gap、2px 内边距、标题上 6px 下 2px 贴着下方的行、分隔线上下 2px。这样恢复了实测的
196px，而不改变其他 popover 或 `Menu.GroupLabel`。

**后台任务。** [flat material 笔记](2026-09-23-ui-flat-material.zh.md)去掉了分组的卡片，
也连带去掉了所有状态标记：已完成的行没有图标、比运行中的行靠左一个 spinner 的宽度，
标题也看不出分组仍在运行。Owner 否决了这次扁平化：任务是在这一轮旁边运行的，而不是
它的一个步骤，等待它们的人需要一个固定的地方看。分组重新成为卡片（1px 分隔色描边加
淡淡的抬升底色，即 v2 前的样子，用 `@lody/ui` token 表达），任务是整宽、用分隔线隔开
的行，超过 22rem 时在卡片内滚动；每行开头在同一列有 14px 标记：spinner、对勾、叉、
待开始的虚线圆。有任务运行时标题显示 spinner，全部结束后显示折叠箭头。时间或状态放在
行尾。扁平版引入的 peek popover 保留。

## 第三轮评审：焦点环与命令面板

**焦点环只跟随键盘导航。** 用鼠标打开、用 Esc 关闭的对话框会把焦点交还给触发它的
控件，而 Chromium 因为最后一次输入是按键，会让它匹配 `:focus-visible`——于是一个没人
导航过去的设置行亮起 2px 的强调色环。Owner 认为在不需要无障碍的时候，这些环本身就是
视觉障碍。`:focus-visible` 无法区分导航和操作，所以 `@lody/ui` 现在自己跟踪输入方式
（`installFocusModality`，装在 `AppInitializer` 和 Storybook preview 中）：Tab 以及
文本输入以外的方向键表示 `keyboard`，指针按下表示 `pointer`，Esc、Enter、Space 不改变
它。在 pointer 模式下它把新的 `focus.ringWidth` token 置零——各组件族的 `ringWidth` 和
产品自己的 StyleX 焦点环都读取它——并在 `<html>` 上写 `data-focus-modality`，从而也
约束旧的 Tailwind `focus-visible:ring-*` 和外壳的兜底内描边。文本输入保留焦点环。表示
“已选中”而非焦点的环（onboarding 中选中的行、分享卡片选中的色块）保持固定宽度。否决的
方案：Esc 后不归还焦点会让键盘用户丢失位置；`focus({ focusVisible: false })` 在 Chromium
中未实现。Chromium 实测：无跟踪器时 Esc 后获得焦点的按钮绘制 `0 0 0 2px`；有跟踪器时为
`0px`；按 Tab 后恢复 2px。

**命令面板。** ⌘K 面板原本是旧的 shadcn 外壳：固定 640px 高、短列表下方大片空白，每条
命令都是灰色方块里同一个 ⌘ 图标，每行两个灰色键帽，页脚也是键帽。现在面板从固定的上沿
垂下（输入框不会移动），高度随结果变化。每条命令的图标表达它的动作（`command-icons.ts`，
按 id 映射，因为内置占位命令与之后注册真实命令的组件共用同一个 id）；没有图标的命令留空
而不用替代图标。对话的图标在混合搜索中把它与命令区分开。无查询时命令按类别分组；有查询
时仍按相关度排序。快捷键是像菜单那样安静的尾部文字；高亮是由 cmdk 受控值驱动的墨色
底色，因此可以用 StyleX 实现。

## 验证

- 中文 Storybook 前后截图：偏好设置浮层、`data-settings-surface` 下的账号页、
  两种项目窗口、两种配色下的侧边栏 tooltip，以及图片预览卡片（含弹簧动画中途的
  一帧）。
- `tests/chat-composer-focus.test.tsx` 覆盖预览卡片：点击缩略图打开一个非模态
  卡片，内含图片和文件名，按 Escape 关闭。
- `main` 上的 `Chat/ChatComposer` stories 无法渲染：添加菜单会读取云端查询，而
  这些 stories 没有提供 platform。现在改用设置页 story 的 providers。
- `tests/github-settings-view.test.tsx` 覆盖按 owner 分组、摘要、开关、搜索以及成员
  只读列表。
- `packages/ui/test/focus-modality.test.tsx` 覆盖输入方式切换；
  `tests/command-palette-view.test.tsx` 覆盖分组标题、方向键高亮、Enter 与空状态。
- 未在打包后的 Electron 应用中验证。Storybook 渲染的是同一组件，但不在应用外壳中。
