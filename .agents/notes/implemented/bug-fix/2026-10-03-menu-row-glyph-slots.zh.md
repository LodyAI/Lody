# 菜单行把图标画成了 24px:图标槽被绕过了两次

Status: implemented
Translation: current

[English](2026-10-03-menu-row-glyph-slots.md)

## 摘要

会话信息栏的合并方式下拉把选中项的对勾画成了 24px —— 远大于行内文字 —— 因为
`PrMergeButton` 把一个裸的 lucide `<Check>` 放进了 `Menu.Item` 的 children 里,
图标落在标签的 flex 行上,按图标库的默认尺寸渲染。同一种失误还以相反方向大
面积存在:约 48 处 `Menu.Item`/`ContextMenu.Item`/`Menubar` 调用方把 lucide
图标通过 `icon` prop 传进去却没给尺寸,于是在槽位固定的 16px 盒子里画出
24px;还有若干单选选择器在标签里手绘对勾,而没有用 `Menu.RadioItem`。这些行
现在使用原语定义的槽位(`icon`、`endContent`、`tone`、`indicator`/
`indicatorSide`),手绘对勾的选择器都改成了真正的 radio 行;`icon` prop 本身
也改为直接收图标*组件*(`icon={Check}`):由盒子以 100% 填充 class 实例化,
漏写尺寸从此不会静默溢出。元素形式(`icon={<Check />}`)只留给需要自带
props 的字形(`Spinner` 的 `size`/`label`、调过的 `strokeWidth`),并保持其
声明的尺寸。刻意做成复合布局的行(头像、多列项目条目)保留自定义
children。

## 证据

- `Menu.Item` 的 children 被包进 `itemText`,即标签的单行 flex 容器
  (`packages/ui/src/popup/surface.ts`、`row-label.tsx`)。lucide 图标作为元
  素子节点按自身的 `width`/`height` 属性(24px)渲染,而标签约 13px。截图证
  据:PR 信息栏合并下拉里的对勾明显大于行高(`pr-merge-button.tsx`)。
- `icon` prop 把图标放进 `itemIcon`,一个固定 16px 的盒子,但盒子约束不了子
  元素(StyleX 没有后代选择器,所以 `@lody/ui` 明文要求调用方的字形「声明为
  100%」)。`<svg width="24">` 作为 flex 子项无法缩到固有尺寸以下,因此每一
  个没写尺寸的 `icon={<X />}` 都是 24px 居中溢出 16px 槽位 —— 约 48 处,大
  多数来自 #999(「把侧边栏右键菜单图标收进 icon 盒」)迁移时把图标移进了
  `icon=`,却保留了原本没写尺寸的元素。
- 手绘选中标记在重复 `Menu.RadioItem` 已提供的预留指示框:
  `mobile-account-settings`(member/admin)、`acp-session-select`、
  `workdir-mode-selector`、会话头部菜单的 IDE 启动器选择器(两处)、owner
  选择器、`organization-switcher` 以及 `unified-project-selector` 的项目
  行。每个都在手写 `<Check>` —— 有尺寸,看起
  来没问题,但距离这次一模一样的 bug 只差忘写一个 size class —— 而且全部上
  报的是 `role="menuitem"` 而不是 `menuitemradio`。
- 另有约 30 行(集中在 `session-chat-interface.tsx` 的会话头部菜单)把尺寸正
  确的 lucide 图标塞在 children 里,手工重造了槽位:尺寸(`h-3.5`、`h-4`)
  和颜色(`text-muted-foreground` 或继承标签色)各不一致,而不是槽位统一的
  盒子和 hint 色;删除行也用 `text-destructive` class 绕过了
  `tone="destructive"`。

## 决策

- `pr-merge-button.tsx` 用真正的 `Menu.RadioGroup` + `Menu.RadioItem
indicator="check"` 渲染合并方式选择 —— 与 `PrPrimaryAction` 的合并方式菜单
  同一套词汇。
- `MenuRowProps.icon` 放宽为 `ReactNode | ElementType<{ className?: string }>`。
  传组件时由 `itemIcon` 通过 `createElement` 挂上 `surface.itemIconGlyph`
  (`width/height: 100%`)实例化 —— class 压过 svg 的 px 属性;传元素时原样
  渲染,保留其声明的尺寸。所有 lucide 调用点都改成了组件形式
  (`icon={Check}`);元素形式只剩需要自带 props 的字形
  (`<Spinner size="small" label={null}/>`、调过的 `strokeWidth`、按行传参的
  `SidePanelTabIcon tab={panel}`)—— 对 lucide 依旧意味着 `size="100%"`。
- 手绘对勾的选择器改为 `Menu.RadioGroup` + `Menu.RadioItem`;leading 槽位放
  身份标记的行(头像、启动器品牌图标)用 `indicatorSide="end"` —— 正是这个
  API 存在的场景。
- 普通 leading 图标的行把图标移进 `icon=`,末尾标记(复制提示、状态文本、
  popover 信息按钮、`Switch`)移进 `endContent`,删除行改用
  `tone="destructive"`。
- 尺寸默认值归原语而非调用方:组件形式让「填满盒子」无漏可写 —— 盒子实例化
  字形时自己喂填充 class。起初试过给裸图标元素 `cloneElement` 注入 style 兜底,
  后来放弃:在调用方的元素背后塞 props 是猜谜(Fragment、吞掉 `style` 的组件),
  而组件形式把所有权摆到了明面上。
- 保持原样:确为复合布局的行(`recent-run-config-menu-group`、
  `settings-line-tabs`、`organization-switcher` 的头像行、居中的「+」创建
  角色行、`desktop-run-config-menu` 里禁用的 agent 值行)—— `itemText`
  本来就允许放调用方的标记,且这些都已写好尺寸。

## 已考虑的替代方案

- **用 `cloneElement` 给裸图标元素注入填充 style**:试过又放弃 —— 它在调用方
  元素背后改 props,对 Fragment 和吞掉 `style` 的组件无能为力,而且依然把「尺
  寸归谁管」答成「没人」。组件形式直接回答了这个问题:盒子负责尺寸,因为字形
  由盒子创建。
- **对 `itemIcon` 里所有字形强制 100%**:元素形式仍尊重已声明的尺寸 —— 盒子
  里本就刻意放着非 100% 的字形(调过 `strokeWidth` 的图标、居中放在 16px 盒
  里的较小标记)。
- **用一条全局 CSS 规则给字形盒里的 `svg` 定尺寸**:StyleX 没有后代选择器,
  且包设计上不发全局样式。
- **只修可见的坏行、保留有尺寸的 children**:超大对勾是唯一肉眼可见的坏行,
  但约 48 处未写尺寸的 `icon=` 以同样方式溢出,每个手绘对勾都只差一个漏写的
  class。收敛到槽位 API 才是持久的修法,也让选择器获得正确的
  `menuitemradio` 语义。

## 验证限度

- `vitest` 的 `session-header-menu` 与 `session-info-context-actions`:
  16/16 通过,包含改成 radio 的启动器与合并方式选择器(选择器已更新为
  `menuitemradio`)。`tsgo` 对改动文件无报错(嫁接自同仓另一检出的
  `node_modules` 产生了与本次无关的缺包噪音)。
- Storybook + Playwright 目验:逐个打开菜单并量测字形 —— 合并方式拆分按钮、
  会话头部菜单(IDE/owner radio 子菜单)、项目选择器、附件菜单、workdir 选择
  器、文件操作、侧栏面板 tab 条、composer run config、侧栏帮助菜单、workspace
  选择器、移动端角色选择器,以及会话/工作树/置顶右键菜单,全部 ≤18px 且语义
  为 `menuitemradio`。这次目验抓到了源码扫描漏掉的一类:`icon` prop 里的*三
  元表达式*图标(`<PinOff/>/<Pin/>`、`<Users/>/<Spinner/>/<LockKeyhole/>`、
  `<Pause/>/<RotateCcw/>`,分布在六个 sidebar/task/schedule 列表文件,修复前
  量到 16x24,修复后 16x16)。菜单之外的 Field/Badge/ActionCard `icon=` 未动。
- `Select`/`Combobox` 行和非菜单 popover 未审计;本次扫描只覆盖
  `Menu`/`ContextMenu`/`Menubar` 的行部件。fork-destination 的 story 触发器在
  Storybook 里打不开菜单(story 自身的受控/非受控警告,与本次无关,且受控
  `open` 测试已覆盖)。
