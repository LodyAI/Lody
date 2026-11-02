# 逐个界面从 Tailwind 迁移到 StyleX

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875)（草稿）

[English](2026-10-22-tailwind-to-stylex-migration.md)

## 摘要

Lody 的产品界面同时使用 Tailwind v4 与基于 StyleX 的设计系统。本次保留两者共存，
将组件自有样式逐批迁入应用现有主题变量和尺度，并保持控件 API 与实际渲染行为。
续迁处理共享侧栏行、聊天输入、移动连接控件、预览批注、会话、终端、日程
及共享 UI 适配层的自有样式；修复前期 class 合并与 Token 错误，并建立涵盖 Portal、交互及
精确响应式边界的浏览器证据。整体迁移仍未完成：控件兼容覆盖、第三方选择器和
尚未访问的应用状态均明确留待后续，不以构建成功或 utility 数量推断完成。

## 样式所有权

[产品样式层](../../../../packages/components/src/style/README.md)拥有应用颜色及尺度。
组件拥有本地 `stylex.create`；同一区域重复的样式放在相邻 `surface.ts`。
`@lody/ui` 继续拥有控件外观。既有控件覆盖应作为兼容项保留，直到替代实现保持实际结果；
将优先级更高的 Tailwind `minHeight` 改成调用方的 StyleX 类，并不保证它能覆盖控件自己的
StyleX `minHeight`。

产品颜色读取与 Tailwind 相同的根 CSS 变量，保留 VS Code 主题及 Portal 行为，避免
Portal 离开 `@lody/ui` 调色板子树后使用不同颜色。任意透明度仍保留原表达式，不为每个
数值创建 Token；[ALPHAS.md](../../../../packages/components/src/style/ALPHAS.md)
维护表达式清单。

一次性重写会混合视觉重设计和样式所有权调整。本次以具有真实渲染场景的组件或小模块
为单位推进。[迁移指南](../../../../packages/components/src/style/MIGRATION.md)
拥有级联、焦点与阴影、排版、CSS hook 和验收约定。

## 续迁批次与修正

状态标记、项目入口与重命名续迁在六个组件中再减少 75 处编译器确认的 utility：
WorkingGrid 8→0、WorkingGridCollapse 13→0、WorkingStatusMark 4→0、Spinner 7→2、
MobileProjectEditSection 30→0、RenameSessionDialog 29→14。Spinner 保留动画 hook 和
祖先选择器使用的 SVG 尺寸标记；重命名保留 primitive 布局、字体及 Textarea 覆盖。
公开属性、DOM 结构、内联样式、测量、动画及输入/保存处理均保持不变。项目入口保留
运行时圆角、字重、行高变量，通过非默认调色板/比例浏览器对照，不用默认值相同的
常量替代变量合同。

本批 434 组主对照记录的样式与几何一致，阈值差异为零，其中 425 组 PNG 字节一致；
九个项目键盘状态仍有少量原始像素差异。项目原生输入 48 组字节一致；重命名 44 组
原生、八组指针重试均无阈值差异，分别 42、七组字节一致，阴影变体可在未改变源码上
复现。状态动画仍未完成视觉验收：120 组中 107 组字节一致，13 个正式帧保留 9,518 个
阈值像素，计算几何、样式及动画观测却一致。78 张交替版本对照在每个差异状态均复现
跨版本相同的完整 PNG，但部分正式变体尚未复现。这 13 帧不归为抗锯齿、不扩大阈值，
也不与早期 20 帧/115 像素限制混算。自包含 `leaf-acceptance.html` 汇集真实前后截图、
控制实验及准确限制。合成 composition 事件仅验证 DOM IME guard，不代表原生 OS IME；
设备描述符仅代表 Chromium 触屏仿真。

前后均实际构建并运行 OSS 桌面，覆盖真实 main、preload、IPC、内置 CLI 和隔离的本地
聊天。验收工具在拍照前等待 TourStill 相机及前景祖先几何稳定，因为截图动画开关无法
终止 JavaScript 弹簧。最终三个应用状态无阈值差异，Explore 正式对照仍有 16,155 个
阈值像素。同一最终构建的两次独立启动出现不同的稳定前景 PNG，第二次及三张重复图
完整复现迁移前整张 PNG。41 个前景节点排除非视觉耗时变量后，计算样式及文字几何
相等。这证明运行间栅格变化，但没有确定合成触发；报告仍保留正式差异图。

Emoji Picker / Drawer 续迁再移除 116 处编译器确认的 utility：Emoji Picker
87→3，Drawer 67→35。Emoji 的选中主题底色和 Spinner 控件尺寸保留兼容类；
Drawer 方向变体、头部断点和动画 hook 保留 utilities 层优先级，避免原先无效的
公共调用方宽度、定位、边距、圆角或边框覆盖开始生效。静态布局和排版复用
现有本地 StyleX Token。

Diff Viewer 续迁将五文件清单从 135 处降至 27 处，在 Viewer 与三个评论/操作
叶组件中移除 108 处 utility；Markdown 后代规则保持原样。评论附件保留固定
中文/原生字体栈，因为旧 `font-sans` 并不读取应用字体变量；未生成 CSS 的触控
类不新增行为，头部 hover 继续读取原本未定义的 `--accent` 表达式。卡片/控件
组合、阴影变量及公开 Add 按钮 hover/active 的优先级仍用兼容 utility 保留；
Worker、缓存、生命周期与事件所有权不变。

透明度续迁在五个文件中修复 16 处经编译器确认的声明，恢复两处移动 hover
媒体条件及原有动态 amber 调色板合同；再迁移五处自有 utility：移动 Viewers
标签间距及文件通知根节点四个属性。控件/调用方兼容项保持。两个移动 sheet
选定的透明度值均已审计；conversation view 尚有 25 处、侧栏行尚有五处未访问的
直接 alpha 转换，精确位置及所需场景列于 `alpha-five-file-audit.json`。这些是
已知待审项，不代表整文件样式等价已获证明。

| 批次           | 范围                                                                                             | 保留的兼容项                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 页面及提及     | 六个认证/工作区页面、五个提及/编辑器叶组件；页面共享布局放在 `pages/surface.ts`。                | 控件字号/尺寸/错误样式、任意创建选项的兄弟间距、菜单调用方布局。                                                  |
| 文件与视觉评论 | 桌面/移动生产文件浏览器、批注浮层及草稿编辑器；新增 Story 直接挂载真实桌面浏览器和草稿组件。     | 控件覆盖；浮层剩余自有样式由下述后续批次完成；移动钻取动画 hook 继续使用其所属 CSS。                              |
| Session 叶组件 | 用量浮层、关联关系树、通知权限提示。                                                             | 既有控件及 dark 覆盖；三个文件经编译器确认的 utility 从 165 处降到 18 处。                                        |
| 侧栏行与外壳   | leading 槽位、共享行部件、Updated 列表、侧栏外壳与本地项目行。                                   | group/menu/dark/focus hook、控件覆盖、滚动条/sash 集成与归档浮层定位；五个文件静态 utility 从 674 处降至 116 处。 |
| 聊天及移动控件 | 输入区粘贴文本 Dialog/Drawer、禁用上下文选项、项目清除/图标显隐 hook、连接状态及移动页眉叶组件。 | 保留控件尺寸/字号/后代覆盖及硬编码 dark hook；五个文件经编译器确认的 utility 从 234 处降至 144 处。               |

四文件控件批次将编译器确认的 utility 从 348 处降到 161 处：
`session-list.tsx` 31→8、`terminal/terminal-dock.tsx` 107→3、
`schedules/schedule-property-row.tsx` 82→28、`ai-gui/view.tsx` 128→122。
View 只迁移 activity 警告色、元信息直接子行的逻辑 margin 和配置列表 padding；按照
原编译器保留兄弟间距，没有替换为 gap。公开侧栏类名字符串 helper、控件覆盖和终端集成
hook 继续保留。连同前一批五个聊天/移动文件，九文件从 582 处降至 305 处，共移除 277 处；
其中本次四文件移除 187 处。

后续七文件批次将 utility 从 297 处降到 104 处，移除 193 处：
`preview/visual-annotation-comments-overlay.tsx` 69→0、
`sessions/session-chat-interface.tsx` 89→75、
`sessions/session-search-context.tsx` 16→13、`shared/swipe-action-row.tsx` 41→3、
`sessions/message-queue/queued-image-preview.tsx` 22→4、
`schedules/schedule-recurrence-editor.tsx` 38→2、`sessions/session-pin.tsx` 22→7。
迁移范围是组件自有样式，保留的控件与公开类名字符串合同继续属于组件边界。

共享适配层批次将六个 `src/ui` 文件的 utility 从 293 处降至 43 处：
`command.tsx` 100→34、`slider.tsx` 33→0、`copy-button.tsx` 27→0、
`resizable.tsx` 37→0、`collapsible-card.tsx` 62→8、`scroll-area.tsx` 34→1。
原生 range 语义、剪贴板回调与计时、Radix 生命周期补丁、分栏调整及折叠事件继续由原实现
拥有。保留项涵盖控件覆盖、第三方后代选择器、强制颜色轮廓、动画、祖先状态及滚动视口
直接子节点的 important display 规则。

候选 CollapsibleCard 的 CSS 自定义属性被输出到 StyleX 层之外，抹掉了调用方任意阴影。
保留原成对的 `shadow-none ring-0` 类维持 `cn` 组合，其余自有样式正常迁移。
静态 class-only 合并同时保留公开 inline style，避免 helper 的 undefined style 覆盖它。
Copy 的 blur 表达式保留经编译器确认的 4px fallback：Storybook utility 可能仍保留
`--blur-xs`，但产品已经没有对应 utility 消费它。这些是兼容边界，没有新增主题值或重设计。

浏览器对比修复了 CompleteEmail 页面少 12px 的间距，以及 Join 文本框从 112px
退到 72px 的问题。后者保留原 `min-h-28` 兼容类。等宽路径同时保留字体家族与全局连字偏好。

审查还发现 PR 合并控件、水下装饰及蓝图动画 hook 中有 23 处未合并 `className`，
导致其与 StyleX props 相互覆盖；现改用既有 helper 合并。Onboarding 紧凑表单样式也在
一次 `stylex.props` 中组合，避免第二次 spread 被前一份 class 替换。水下组件当前没有
产品调用方，因此其源码修复不能作为此前主流程发生可见故障的证据。

**对前期 Token 实现的修正：** 八个默认阴影值复制错误，使草稿卡片和选中计费选项在
几何尺寸不变时仍产生视觉差异。修正值来自锁定版本 Tailwind 编译器和真实浏览器解析，
不是记忆中的尺度。Chromium 核验了全部 11 级阴影；其他尺度的 62 项检查中 61 项精确
相同，只有 `rounded-full` 的半径表示不同，但都已饱和为圆形。

侧栏续迁又发现一处同属性冲突：归档控件在确认态拥有 `position: relative`，调用方浮层
改成独立 StyleX 类后参与了 flex 布局，末尾槽从 20px 扩至约 120px，标题列随之变窄。
短标题 PNG 完全相同也掩盖了这个几何回归。调用方保留 `absolute z-20` 兼容类，使用
长标题确认态与明确的槽位测量验证修复；控件 API 和归档行为均未改变。

聊天续迁使用组件自己的 data 属性限定 StyleX 祖先 marker。未限定的默认 marker 还会
响应无关外层的悬停和焦点：真实嵌套 wrapper 控制实验复现了候选版回归；限定后的最终
实现与原命名 Tailwind group 一致。Tabs、菜单、抽屉材质及 Spinner 尺寸保留控件兼容项。
禁用提示原有的触摸点击限制及输入框原有的清空高度行为均明确保留，没有借迁移重设计。

终端审查捕获并修复了真实候选回归：后续条件 StyleX color 槽抹去了 New 按钮的正常
hover 色。将结构与颜色职责分开，并在同一 color 槽声明 hover 和 disabled-hover 后，
恢复了原结果。日程原生输入的 hover 也保留 Tailwind 的 `(hover: hover)` 媒体条件，
真实触摸控制确认它不会应用于无 hover 设备。业务事件与生命周期保持不变。

后续浮层迁移将 ring 与任意阴影整体迁移，保留原焦点状态：应用全局 reset 会移除
ring，但阴影仍然存在。自有 marker 条件保持悬停与焦点作用域，精确 dark 选择器保留
嵌套 light-scope 的排除规则。原调色板变量附带编译器核验的精确 fallback，避免最后一个
Tailwind utility 消失后变量声明被移除。Swipe 键盘检查保留原透明焦点 ring，验证焦点与
Enter 行为，不宣称存在可见的焦点指示器。

归属叶组件续迁实际移除 13 个工具类：`usage-calendar-skeleton.tsx` 11→7、
`session-info-bar.tsx` 7→0、`conversation-outline-rail.tsx` 7→5。Skeleton 只迁移
四处调用方布局，包括准确的局部 `calc(var(--spacing) * 1.5)`；primitive display、
圆角及已记录的环形材质继续保留。InfoBar 保留完整应用 dark/light-scope 选择器、
局部 input/border alpha mix 和调色板覆盖。amber/emerald 变量附带锁定调色板的精确
fallback，因为最后一个 utility 消失后编译器可能裁掉变量声明。即使自有静态工具类为零，
导入的 composer elevation 类和未解析类名组合仍是依赖。

Outline Rail 保留三个祖先状态颜色 group、`@[928px]:flex` 边界及预览卡片 `p-3`。
真实公开调用方会把静止刻度改为紫色，但原 hover/focus 选择器仍覆盖它；若把这些规则
移到更早的 StyleX 层，调用方反而开始获胜。本次只迁移两个滚动条工具类，保留原合同，
不提高 specificity，也不修改控件 API、DOM、事件、几何引擎或生命周期。

连接／队列续迁再减少 14 处：`acp-session-select.tsx` 43→36、
`stuck-connection-banner.tsx` 14→10、`message-queue-display.tsx` 12→9。ACP 迁移
七处自有图标／chevron 工具类，保留精确元素局部 spacing 表达式。连接提示迁移一处
Spinner 颜色，删除三处 Button／Spinner 已提供的重复 shrink 类；Button 负 margin 及
primitive 外观继续保留。Queue 仅迁移内部滚动区三个工具类，保留局部 border-style
变量和准确的 30% border mix。公开根节点九个工具类不变：原 utilities 层覆盖 opaque
StyleX 调用方，而 `cn` 对 utility 调用方另有冲突解析；迁移根声明会改变公开组合合同。
DOM、事件、hooks、内联几何及 recovery／queue 所有权不变。

共享 Skeleton 警告修复是独立的 primitive 修正。只有某轴已提供（`!= null`）时才组合
对应的独立动态 width／height 样式，保留显式零值和另一轴的 shape 默认尺寸。曾用 null
替代缺省轴的候选通过单元测试，却清掉真实 line 默认高度，使 width-only line 从 20px
变成 0px；候选及失败浏览器证据保留。最终拆分仍在一次 StyleX 组合中处理两个已提供的轴，
props 改变时清理旧内联尺寸，不重设计 shape、默认值或调用方 API。

## 可复现证据

[视觉工具](../../../../packages/components/tests/visual/visual-regression.mjs)在 Chromium
中截图生产 Storybook 组件，生成内嵌 Before/After/Difference PNG 及原始计算样式变化的
独立 HTML。[运行指南](../../../../packages/components/tests/visual/README.md)
维护命令及目标配置。截图等待真实可见内容、字体、有限动画和稳定几何，延迟提示不能以空白
通过；预期为空的用量状态需显式列入允许清单。布局快照包括 Portal。续跑校验构建/目标/工具
身份，失败或缺失场景继续展示；独立键盘 peek 会先将鼠标移开。

726 对截图中，711 对 PNG 文件逐字节相同，723 对没有超过所记录 RGB 阈值的像素；
所有已记录的几何与字体属性一致。剩余三帧在控件角部各有四、三、三个超阈值像素。
重复拍摄原版与迁移版 CreateWorkspace 未复现其两处差异；草稿角部差异仍未确定原因。
报告保留颜色、阴影及饱和半径的原始表示变化，即使 PNG 相同，也不计为样式精确一致。

前期验收集合包含 89 个 Story、726 对截图，覆盖 390/768/1280px、明暗主题，以及
文件浏览器的 767/768px 边界。状态包括文件钻取、文本/二进制/错误预览、批注悬停与键盘
peek、草稿输入和禁用、已打开的用量浮层。另一次真实 OSS Electron 运行通过实际 preload、
IPC 和 bundled CLI 走过 onboarding、Agent 配置、Explore 及可编辑本地聊天；使用隔离
数据目录和随机端口，验证清理并记录构建哈希。这些应用图片只是 After 烟测证据，不是
应用级前后视觉回归。

侧栏报告包含 40 个 Story 的 550 对截图：548 对 PNG 逐字节一致，550 对都没有超过记录阈值
的像素，137,184 个记录节点的几何、字体、透明度和标签均无变化。剩余两帧 PNG 级变化
属于锁定浅色的项目概览 Story，报告继续明确保留。
侧栏报告补充整体布局、行部件、长标题归档、空态/加载态、显示全部/收起、选择、嵌套和
底部菜单。窄宽桌面 UA 截图只证明紧凑桌面布局；独立 iPhone/Android Chromium 设备描述符
覆盖真实移动设备检测与触摸菜单/归档。已知 logo 必须可见后才截图，因为 Base UI 会先
预加载图片再挂载 `<img>`。显式阻断主机的配置测试真实离线头像 fallback，并保留原始
网络不稳定帧；真实头像加载控制还对比资源哈希及渲染样式。正常运动发送环按 SVG SMIL
的 0 与 0.6 秒相位比较；固定 Date 与 Playwright 禁动画本身不能同步 SMIL。明确锁定浅色
的 Story 不计为实际暗色渲染。

截图工具为每个 Story 新建页面。复用 worker 页面会让原生前进/后退状态受 worker 分配
影响：表面上十个像素的箭头颜色回归，实际是在比较禁用与启用两种状态。新页面及明确
相同历史序列的控制截图在两个构建间逐字节一致，原始截图哈希也精确对应这两个不同状态。
补拍同时保留原始证据与独立历史状态，不修改产品导航颜色。

侧栏重建前后分别运行隔离的真实桌面应用，保留 Before/After 图片。启动动画没有统一
相位，因此这些图是补充视觉证据，而不是整个应用的像素门禁。

聊天/移动报告新增 44 个 Story、494 对截图：487 对 PNG 逐字节相同，492 对没有超过
记录阈值的像素，37,506 个记录节点的几何、字体、透明度、标签和路径均一致。两帧在
附件/引导边缘保留一、两个超阈值像素；原图、独立控制及未确定原因均明确记录。
计算样式差异仅限背景色表达式、饱和大圆角和透明阴影表示。独立聊天交互比较 210 个
节点，覆盖 Dialog/Drawer 编辑、图片预览、键盘焦点及输入高度。稳定 Drawer 补拍
逐字节一致；同一未改构建的连续截图也会出现其首帧微差。真实 Electron 在生产重建
前后分别运行，继续作为补充应用证据。

视觉工具现将 Portal 定位容器纳入几何稳定检查。搜索 Story 结束不能证明菜单自动焦点
交接时已成功输入：真实原版在 finished 后仍可能 query 为空。显式输入并等待筛选结果，
才能确认两侧状态相同。多 Story 连接状态切换也曾在两个构建中产生空内容超时；独立
补拍全部 30 对连接状态后 PNG 逐字节一致。成功补拍替代对应帧，但来源 phase 保留
失败历史，没有用产品样式补丁掩盖问题。

会话/终端/日程/View 报告新增 35 个 Story、646 对截图，无缺失或未解决的采集失败：
640 对 PNG 逐字节一致，642 对没有超出记录阈值的像素。83,616 个记录节点保留 17 处
背景色表达式差异及 65 处隐藏 xterm scroll-area 高度差，其余几何、字体、透明度、标签和
路径一致。四帧各保留九个超阈值像素，均位于未迁移的 fixture Button 角缘；同一未改构建
的独立复拍可重现，精确绘制触发机制未证实，不归因为抗锯齿。另两帧 PNG 微差低于阈值。
原始图片及原始样式均保留。

隐藏 xterm 几何还通过实际滚动核验：两个不可变构建各自都会出现初始 0 或 280px 的
scroll-area 高度，120 个动画帧后仍保留，而可见 viewport 的 clientHeight 与 scrollHeight
均为 280px。每版三次真实文本输入，各用 600 个 probe 填充实际 xterm buffer，滚动高度
变为 1300px；滚轮到底为 1020px 并显示 probe 599，回顶为 0px 并显示原始标题及
probe 000。六张初始 PNG 同哈希，六张回顶 PNG 也同哈希。证据将差异定位到 xterm 初始化
结果，未声称找到唯一上游回调，也没有仅因节点隐藏而忽略它。

补充控制包括六对 SessionList 祖先 marker、四对真实加载头像、20 对终端拖拽/键盘、
两对实际填充 buffer 滚动及四对真实 Electron 截图。最终 Electron smoke 时间为
`2026-10-22T14:02:35.536Z`，使用重建后的生产 renderer；同此前应用图片一样，启动动画
相位不能作为全应用像素门槛。`continuation-acceptance.html` 合并最近聊天与控件两批：
1,140 对截图，1,127 对 PNG 逐字节一致，1,134 对在阈值内，另有 64 对补充证据。
每批保留自己的 before/final 构建及逐帧来源，不能解释为所有 after 都来自同一构建。

后续七文件报告包含 32 个 Story、972 对独立截图；搜索采集的 224 帧中排除了四个重复
rest 状态。972 对中，966 对 PNG 逐字节一致，970 对没有超阈值像素。64,196 个记录节点
的几何、字体、透明度、标签、路径、圆角和阴影全部一致。1,603 处背景色序列化从
`color-mix` 变为等价 HSL alpha，PNG 保持一致。真实浏览器截图及原始计算样式变化均保留。

主矩阵两帧搜索结果在未改 UserRound 图标及头像边缘保留七个、五个超阈值像素。24 对独立搜索
控制中，两帧在未改 Search 图标保留 28 个像素。135 对祖先节点样式的完整精度与 DPR 1
控制均一致，同一未改最终构建、同一状态既能得到零差异，也能得到 28 像素差异。
这证明绘制结果可变，但未证实精确触发条件，不归因为抗锯齿；原始图片保留。

主矩阵包含 96 对正常运动模式下的 trusted CDP 触摸输入，覆盖滑动提交阈值、纵向 pan、
独立关闭以及键盘 Tab 焦点/Enter 行为。浮层 232 对及另 14 对正常运动 marker/peek 控制
全部逐字节一致。这 14 对、24 对手动搜索控制及七对真实 Electron 构成 45 对补充证据。
真实 Electron 在 `2026-10-22T15:13:35.785Z` 与 `2026-10-22T15:22:50.085Z` 于 renderer
重建前后运行，操作实际 daily/weekly/monthly 日程编辑器、键盘 weekday 切换、时间编辑
及 month-day 点击，没有保存。固定基线与最终构建分别标识；补充应用图片仍受前述启动
动画相位限制。

共享适配层报告新增 760 组 Chromium 主对照：754 组 PNG 逐字节相同，759 组没有
超阈值像素。31,134 个配对节点的几何、字体、opacity、tag 与 path 全部一致。原始样式
仍保留 286 项 shadow、102 项 backgroundColor 和七项继承 color 变化。唯一 512 像素
帧比较了不同的原生 Button hover 状态：真实 hover 和外部 touch 控制在同一未修改最终
构建中完整复现原两幅 PNG 的 SHA。六组外部 touch 与十组 hover proof 均字节相同；
原始输入时序未重建，差异帧继续展示。

149 组补充对照包含 32 组原生 scroll、50 组原生 layout、22 组 Firefox range、
22 组 Command 手动状态、三组 caret 控制、16 组 Copy touch/hover 控制和四组真实
Electron。Layout 保留五组、native scroll 保留一组低于阈值的原始差异；全精度控制
复现了两类 layout 绘制变体，仍没有证明精确触发机制。Scroll 的变化位于未修改的 fixture
Button 而非 thumb，共 22 个像素的单通道一步变化，最大 summed RGB 差为 1。Command 手动状态剩余差异为
原生光标，同状态 `caret:hide` 对照字节相同。没有通过源码补丁掩盖这些变化。

按住滚动条的真实截图捕获了 ScrollArea 候选版回归：媒体条件内 hover 规则压过 active
颜色。将 hover 限制为 `:hover:not(:active)` 后，八个按住状态恢复原色，滚动值不变。
修正后的 32 组 scroll 对照没有超阈值像素或计算样式差异。ScrollArea 及 Command
消费者使用后续 6041 构建；其余四个源码未变且不渲染该 ScrollArea 的界面使用 6037。
每帧保留实际构建来源，不宣称全部最终图片来自同一个构建。交付版 Electron smoke
使用重新构建的 renderer，运行时间为 `2026-10-23T06:07:26.571Z`。

静态 Storybook 还需通过 `moduleSideEffects: 'no-treeshake'` 保留真实
`@pierre/diffs` 注册模块：包元数据只列了未发布的源路径。18 帧 diff 消费者基线使用
已保存并核验哈希的原版组件源码，加上该基础设施修复；原先零高度未注册画面不算正文
覆盖。被接受的双方构建均真实渲染三行 shadow-DOM diff。虚拟列表同样要求真实
filter/clear 恢复后再验证挂载行，实际滚动并选择第 79 项。

Emoji Picker / Drawer 报告新增 600 组主对照，PNG 全部逐字节相同；30,012 个
配对节点的几何、字体、颜色、透明度和结构一致，原始记录保留 108 处透明输入
阴影序列化差异。68 组补充验收/控制包含 60 组原生状态、2 组 Drawer 调用方/
宽度控制、2 组光标哈希控制及 4 组真实 Electron 应用对照；另列 4 组失败候选
展示已修复的 forced-colors 描边回归。条件一致的长属性修复原子化 outline
简写与 reset 冲突。一帧原生 Emoji 保留 20 像素光标差异，同一最终构建分别
复现原始两张完整 PNG 哈希。通过真实过滤行数、激活行和可见 footer 确认渲染
完成，早期采集及其差异保留。真实 Electron 前后运行于
`2026-10-24T12:24:32.547Z` 与 `2026-10-24T13:30:34.985Z`，中间重新构建
生产 renderer；启动动画差异仍属补充证据。

Diff Viewer 报告新增 412 组主对照，396 组 PNG 逐字节相同，全部没有超阈值
像素或已记录的计算样式/几何差。132 组原生对照中 131 组 PNG 逐字节相同，
记录状态一致，覆盖真实 shadow DOM、1023/1024px 容器布局、选择、上下文展开、
折叠半程、移动评论手势、真实剪贴板期限与权限拒绝。12 组变量、字体与强制颜色
控制穿透 shadow DOM，PNG 全部逐字节相同。剩余主/原生 17 帧各保留 14–24 个
底角 raw 像素，RGB 总差最多 6；相同构建重复控制可分别复现两张完整 PNG 哈希，
edge 全精度检查中 732 个 deep 节点的 480 项普通 CSS 属性一致。具体绘制触发
仍未证明，未通过产品补丁隐藏。

本批修正了“透明度变体总是直接 HSL alpha”的早期假设：锁定 Tailwind 4.3
使用 oklab color mix，恢复 `text-foreground/90` 的精确表达式消除了候选路径颜色
和字形边缘差。样式指南现明确以编译器原表达式为准；此发现引出后续透明度审计。
`diff-alpha-followup-inventory.json` 保留最初五个候选位置；conversation diff panel
原本已有的 HSL 不能当迁移错误。

高亮与主题应用晚于 shadow 行挂载，两侧大 diff/native 采集现都要求真实已上色
的 token；未就绪原图作为拒绝证据保留。158 组补充展示含 156 组验收/控制及
2 组明确拒绝的候选/采集，其中 4 组真实 Electron 前后运行分别来自
`2026-10-24T16:07:55.008Z` 与 `2026-10-24T16:51:45.401Z`，中间最终重建
renderer；启动动画差异沿用原有限制。

透明度续迁区分未修复的 Current、明确标注的运行时声明控制，以及保留五处
utility 的修正源码参考，两种控制都不是完整历史 HEAD UI。源码参考隔离迁移：
342 组普通 PNG 逐字节相同，18,516 个记录节点一致；保留的 Current 矩阵中
16 帧因恢复原手机 hover 媒体合同而有意变化。五组真实 palette 控制另外验证
明暗变量覆盖及 fallback。

原生验收有明确边界：184 组源码参考对照中 158 组 PNG 字节同、164 组无超阈值
像素，所有记录样式、几何、字体和交互状态一致；20 帧深色 Removal 保留 115 个
按钮圆角阈值像素（各 4–10）。独立全精度 CSS/pseudo/视口与 CDP 图层检查一致，
动画为零。36 帧交替 freshload 控制显示三个抽样状态均有跨构建相同完整 PNG，
一个 Source 参考复现正式 Final 哈希，双方也复现相同两种 cleanup 变体。
这些观察没有复现每个正式哈希、解释具体栅格触发或闭合全部 20 帧，不能称
抗锯齿或全通过。

旧构建的 late-inline 替换本身改变非目标按钮绘制：Sidebar 一帧 432 个阈值
像素、mobile 28 帧 197 个；它们保留为拒绝的参考证据。源码参考消除 Sidebar
差异，未抹去 mobile 限制。报告另嵌 225 组补充对照、20 张真实截图派生 mask
及真实 Electron 运行，完整来源和源码哈希在交付索引中。

大型 alpha 报告使用有尺寸上限且预留宽高的缩略预览，避免 lazy 加载导致滚动
跳位；未改动原始 PNG 按 SHA 内嵌供原图查看。素材解码与长会话 UI 检查分开，
独立 Chrome 完成连续 24 次导航/缩放/断点切换；CLI 会话恢复现场保留，未无
证据归因为 OOM。

生成产物位于被忽略的 `packages/components/artifacts/visual/`，`acceptance.html`
保留前期续迁报告；`sidebar-acceptance.html` 为侧栏续迁报告；`chat-acceptance.html` 为聊天/移动续迁报告；
`controls-acceptance.html` 为四文件控件报告；`continuation-acceptance.html` 合并后两批并保留
各自来源；`next-acceptance.html` 覆盖后续七文件批次；
`round-acceptance.html` 覆盖六个共享适配层及明确标注的控制实验；
`followup-acceptance.html` 覆盖 Emoji Picker / Drawer 与原生控制；
`diff-acceptance.html` 覆盖 Diff Viewer 续迁；
`alpha-acceptance.html` 记录透明度修复及明确未决的原生视觉限制。最早的旧报告不能代表完成：它只展示 88 帧抽查，而更大截图任务两侧各有
668 个失败。本次基线保留续迁开始时的部分迁移状态；旧静态构建无法渲染的 Story 使用精确
原组件源码补充基线，源码副本及每帧来源均保留在本地证据中。

### 元素局部变量作用域

属性行、安装指引与信息 Chip 批次再迁移 73 处 utility，保留原 DOM、事件和控件 API。
此前未被消费的 `PropertyRowWide` 现有真实组件夹具，包含调用方子元素宽度冲突。

| 界面                 | Utility 前 → 后 | 保留约束                                               |
| -------------------- | --------------- | ------------------------------------------------------ |
| 日程属性行与字段标记 | 37 → 10         | 两个未知子元素宽度选择器及八个既有卡片/ghost 兼容项。  |
| Bub 安装指引         | 29 → 8          | Button 外观与尺寸覆盖。                                |
| 信息 Chip 与 CI 弹层 | 33 → 8          | 原语最大宽度、内边距和阴影覆盖；宽度与边框色单独迁移。 |

子树变量检查发现真实回归：`stylex.defineVars` 在定义作用域解析依赖，继承的别名
已在根节点解析 `--spacing`、圆角及颜色，而原 utility 在元素自身读取这些变量。
日程标记从 24px 变成 16px；安装行从 13px 圆角 /10px 间距变成 6px /8px。
只覆盖根级变量的检查未发现此问题。拒绝的候选保留日程 16 帧 /711,092 阈值像素、
指引 16 帧 /215,817 像素及 Chip 八帧计算值变化。新声明改用原始局部 `var` / `calc` /
HSL 表达式；既有声明和共享 Token 不变，其余作用域消费者尚未全面审查。
这是变量依赖解析修正，不是布局补偿。

最终 `properties-acceptance.html` 包含 886 组真实截图：698 组主要状态与 188 组
原生输入/局部变量状态。全部无阈值像素差异，记录的样式/几何相等；879 组 PNG
字节一致，其余七组保留 12 个原始像素差异，最大通道差值 3。16 张交替源码对照在
未迁移 Before 源码上复现四张主要差异 After 图的完整散列，具体栅格触发原因未证明。
全字段快照比较 40,174 个节点；另 72 组日程合约比较 2,504 个节点，含真实 Tooltip
列表边距及焦点。报告内嵌原始、被拒及修复后的截图，并醒目标明历史未决证据。

指引脚本最初在变量、字体稳定前采样滚动终点；补齐可观察的字体、几何及右侧滚动
就绪条件后，重新采集两端固定源码，最终 80 组原生截图字节一致。拒绝的测量和 Chip
运行中断于清理阶段的证据保留。手机长链接裁切和 240px 极端双控件行拥挤均与原始
基线字节一致；这些控制不证明原生 OS IME、WebKit 或矩阵外全部主题等价。

### 旧侧栏列表

此前没有活跃产品值消费者的 `TaskList` 与 `SidebarUpdatedTaskList` 现有真实渲染夹具，
剩余 utility 分别从 87 降至 15、95 降至 23。局部样式保留元素变量求值、调用方优先级、
group 标记、拖拽内联变换、DOM、事件及公开 API。保留项覆盖祖先状态、锚点焦点、共享
fade/reveal 及原语组合。Task 的两个滑动 action 色字符串仍位于未解析表达式，不计入 15。

`legacy-acceptance.html` 包含 490 组真实截图：362 组主要状态、128 组原生输入，
99,960 个配对节点；另 104 组 TaskList 观察比较 28,288 个节点，不重复计截图。
全部记录字段相同，包含原生递归 CSS、焦点、输入、伪元素、可信事件及回调断言。
128 组原生 PNG 全部字节一致。全矩阵 487 组字节一致；其余三组保留 29 个原始像素，
其中三个超过既定阈值，最大通道差值 10。这些正式差异仍**未关闭**：根变量重命名输入
底边两像素、未修改的共享 CI 图标一像素；另有窄行角点的阈值以下变化。位置不能证明原因。

交替运行未变源码时，最终源码复现窄行和 CI 图标的正式 Before 完整 PNG，原始源码复现
根变量输入的正式 After。20 张 TaskList 控制截图及 144 张 Updated 支持截图保留全序列，
尚未复现每一种正式变体，不能关闭原差异。报告内嵌九张 Before/After/控制原图，并保持
本批及历史未决项醒目可见。

覆盖真实触摸 390/767/768px、拖拽/取消/排序、重命名、归档、强制颜色、根/子树变量及
调用方覆盖。被拒的混合设备 hover、嵌套按钮 Enter 尝试保留：原行键盘事件会拦截 Enter，
触摸设备也不能激活桌面 hover 控件。最终主要矩阵使用实际可用的桌面指针路径，手机由
原生触摸脚本验证。早期浏览器清理挂起单独保留；最终两端使用同一 headless Chromium
脚本并正常退出。以上为验收脚本校准，未修改原产品交互。

### 活跃会话列表与登录页

活跃的 `SessionList`、`SidebarUpdatedSessionList` 和 `LoginPage` 再减少 110 处
编译器确认的 utility，分别从 97→12、26→9、35→27。项目分组头部保留精确的局部变量
表达式、过渡及拖拽内联样式。Updated 行用自有行属性限定 StyleX 祖先 marker，保留调用方
后代覆盖、精确 opener 导航及共享控件组合。登录页只迁移自有供应商图标容器和 Spinner
外边距，保留 important 后代 SVG 规则及 primitive 尺寸。公开 API、结构、事件及认证
行为保持不变；独立审查与截图分别检查这些边界。

真实截图还暴露了缺少的验收前置条件：几何稳定的登录页仍可能显示被裁剪的未完成表单，
因此 profile 改为等待既有 E2E 的 stage、panel 和展开行完成约定。既有登录故事共享
localStorage，完整矩阵改为串行运行，避免最后使用供应商的输入状态被其他故事改变。
原生拖拽必须达到实际移动位置并检查指针命中；Updated 的静止状态必须等菜单和悬停卡片
关闭，且指针位于行外。修正后重新采集两个不可变版本；初始差异、未修改源码对照及最终
截图分别保留，不以产品 CSS 补丁或像素阈值变化代替可观察的状态完成条件。

`active-acceptance.html` 包含 880 对最终截图，其中主要矩阵 648 对、原生交互 232 对。
878 对 PNG 字节完全一致；两对登录页仍有 518 个原始差异像素，均未超过既有阈值，最大
通道差为 1，渲染原因仍**未解决**。253,476 个截图配对节点的全部主要及原生渲染字段一致；
另有 124 项 SessionList 计算记录、42,624 个节点，不另计截图。保留 5 项原生 SessionList
诊断差异：触屏 hover 成员和最后指针坐标不同，最终命中链、CSS、几何及 PNG 一致。
Updated 最终 450 对截图字节完全一致，其最终关闭卡片状态明确包含菜单移除后的真实指针
重新进入、离开动作，不证明原先一次 Escape 总能关闭悬停卡片。初始拖拽的 119,914 个
原始/117,675 个阈值差异像素、未完成登录表单的 59,833 个原始/58,892 个阈值像素、旧悬停
卡片初轮 100,729 个原始/91,090 个阈值像素、关闭门禁失败候选及未修改源码对照均单独
保留，历史例外仍未关闭。

### 移动端设置与工作区面板

四文件续迁实际移除 68 处编译器确认的工具类：项目设置 57→5、账户设置 76→68、
创建工作区 15→12、删除工作区 17→12。新样式保留元素局部的间距、颜色、圆角、字重、
精确 `color-mix` 以及完整明暗作用域选择器。仅在原语已有相同值时删除冗余收缩类；
控件尺寸、Drawer 覆盖、字段排版及自动关闭确认动作中无法稳定观测的 pending 外边距仍保留。
DOM、hooks、事件、内联样式和公开 API 不变。

`mobile-acceptance.html` 收录 716 对真实浏览器截图：418 对主要状态、290 对原生输入状态、
8 对补充运行时主题作用域探针。62,030 个配对节点的已记录渲染字段一致；账户的一项
`alertDialogOpen` 诊断在稳定前采样，虽最终 DOM 一致，记录仍有差异。仅 670 对 PNG
逐字节一致，其余 46 对保留 16,827 个 raw 像素，其中 7,818 个超过未修改的阈值，均为
**OPEN**。有限的未修改源码对照复现部分完整正式变体，未解释所有变体或证明绘制触发原因。
最大差异位于未迁移的工作区名称 Input 失焦后的内阴影边缘，没有通过补偿 CSS 掩盖。

定位器、长译文和异步夹具的原失败截图独立保留。项目夹具沿用第一份不可变构建；修正后的
账户及工作区夹具另建第二份原始构建，两者四个生产文件均为迁移前版本。真实触摸接触已验证，
不虚构 Chromium 缺失的 `:active` 状态。本地创建拒绝、删除完成后自动关闭、320px 长标题
与关闭按钮原有重叠均明确保留。iOS 分支及键盘 inset 是模拟探针。当前组件包 618 文件、
6,137 测试通过；真实 Electron 构建和四张仅迁移后运行截图通过。根检查仍有既有 Git 身份
测试失败；类型、typed lint、Effect lint、脚本测试及独立边界检查通过。

### 图片预览、Markdown 引用与侧栏兼容

三文件续迁实际移除 33 处：图片预览 16→0、Markdown renderer 27→18、侧栏 37→29。
图片 DOM、object URL 生命周期、回调和共享查看器不变。Markdown 保留 15 个表格变体，
因为真实公开 descendant caller 在迁移层次后会反转优先级；也保留 `leading-[1.55]`，
其 `--tw-leading` 写入会参与调用方字号及行高组合。引用标签局部圆角和两级 transition
变量回退有真实浏览器探针；未解析的基础类字符串仍不包含在文件静态计数内。

真实侧栏截图拒绝第一版候选：头像 16/20/25px 被原语 24px 覆盖，6/7.5px 间距变成 8px，
Help 最小宽度从 160px 变成 200px。原候选主要／原生／触摸截图分别保留
203,530／63,888／10,471 个阈值像素。修复恢复九条精确兼容类并删除失败的 StyleX 声明，
没有提高 specificity。三组最终组件在同一修正不可变构建重采。六项额外 computed-only
观察保留六个私有、非继承 `--tw-font-weight` 写入消失；当前源码和编译 CSS 无读取者，
实际字重及行高不变。

`leaves2-acceptance.html` 包含 348 对不同的已观察状态：206 主要、125 common native、
17 补充证据。共同正式覆盖为 331 对；三项图片手势、十项 Markdown 变量／caller、
四项真实侧栏 tap 独立计数。35,772 个节点的记录渲染字段一致。343 对 PNG 逐字节相同，
五对仍有 7,550 raw 像素，其中两帧共 5,631 个超过原阈值，保持 OPEN。Markdown
114 对全字节一致；侧栏四项 raw 变体保留一个阈值像素，同源对照复现三项完整变体，
没有证明触发原因或关闭正式差异。

图片原生验收明确不完整：完整 Before 有 44 项，完整 After 仅 41 项并有一次暗色 pinch
失败。有限的最终源码重放提供三个不同状态，但原始源码重放也失败，不能据此把完整运行
改写为成功。reduced-motion 和受控时钟手势仍未解决；最终手势证据使用正常动效，
reduced-motion 主要覆盖单列。桌面缩放仍有 7,505 raw／5,630 阈值像素，虽记录的
CSS、几何和媒体字节一致，截图时 JavaScript 尺寸重算仍只是推测。失败、动效模式和
来源哈希均保留。另有 44 张前批工作区光标策略诊断图证明同源边缘可有少量变化，重复
隐藏光标也可出现；这些证据未解释此前大变体，也未关闭历史正式差异。

### 构建与测试发现

Storybook 10.6 的严格初始化包装与共享异步 chunk，在真实 WASM 导入周围形成初始化循环。
单个 Story 的探针通过不足以证明全量构建正确。Storybook 现使用原生 ESM/TLA 并保留模块
边界；截图前已通过多个真实入口验证完整构建。桌面生产配置保留自己的目标和 WASM 合同。

合入前的组件测试在 `NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test` 下全部通过：
598 个文件、5,917 项测试。Node 26 的原生 Storage 会干扰 jsdom 的 Storage fixture；
初轮十个失败在该运行环境下消失，无须修改产品行为。utility 类名断言改为可观察行为与
SVG 结构验证，另删除一个只检查类名的浅测试。组件类型检查、带类型的 lint、桌面
构建及文档检查也通过。根 typed lint
零错误、17,396 项 warning，公开边界、i18n 及格式检查通过。仓库原有 lint/文档
warning 仍按 warning 报告。

与 `main` 的 `cebc2e6171` 合并解决了 17 个文件冲突，保留上游多仓库项目组、排序、
启动能力限制、PR 状态颜色、队列触控对齐、终端几何与新 diff renderer 接口。
主分支删除的 Radix 滚动适配层保持删除；fixture 和原生滚动检查改用 Base UI 的
axis/visibility API，不恢复已删除的 thumb 外观覆盖或 viewport-as-child 接口。

合入后 614 个组件测试文件、6,083 项测试全部通过。根类型检查、typed lint、Effect lint
及根脚本测试完成。根 `pnpm check` 随后在 CLI 测试处停止：SQLite runtime 套件因
本机 Node 26.11.1 低于上游新要求的补丁版本而无法载入，另有一项 Git 身份测试失败。
CLI 共 330 个文件、4,631 项测试通过，两个文件失败、一项测试失败；聚合命令后续阶段
未完成。合成 fixture 提交仅通过命令环境关闭签名，未修改 Git 配置。根格式检查、
公开边界及 i18n 检查通过。这些结果不代表支持的 Node runtime 或 Electron 集成验收。

合入后的不可变 Storybook 构建完成 240 张真实浏览器截图：160 个组件状态、48 个页面
状态及 32 个滚轮/拖拽/键盘状态，另有真实生产组件的 Landing 按钮 5px/92px 几何探针。
这些是合入后的 smoke 证据，不代表与整个主分支像素等价。早期迁移报告仍对应其原有
不可变源码版本；20 帧、115 个阈值差异像素继续保留为未闭合问题。
Landing 面板与标签的重叠也出现在隔离构建、产品代码未修改的当前 main 中：320 个
节点几何一致，截图有 323 个原始差异像素、各通道最大差异 2，阈值差异为零。
手机 Command 对话框左侧裁切与合入前截图字节一致。两项仍列为可见限制，不用补丁
掩盖，也不据此扩大验收结论。`main-merge-acceptance.html` 内嵌合入截图与对照证据。

随后合入 `a3de5d611`，保留上游通知复制布局及 E2EE 分域规则，六个叶组件实现未变。
Storybook 10.6.2 新构建与 434 组集成截图的记录样式/几何相等、阈值差异为零，421 组
字节一致；独立矩阵不替代之前原生差异。当前组件测试 617 个文件、6,124 项通过；
一个 Electron auth recovery 套件因本地缺少新要求的 Electron 44.9.3 二进制而无法载入。
安装器 fetch 失败，GitHub release 下载返回“release not found”。应用构建通过，但该
版本实际运行 smoke 受阻；早期真实 Electron 运行仍仅对应其原有版本。根检查仍在
Node 不支持的 SQLite 套件及 Git 身份断言处停止，CLI 332 个文件、4,697 项通过。
集成证据记录在 `leaf-main-integration-review.json`。

最后同步至 `40e108f1a`，保留上游绝对/相对重置时间切换和弹窗既有 StyleX 样式。
新增切换实现及其样式与 main 结构一致，两个所属套件 21 项测试通过；六个叶组件未变。
此次集成不扩大已冻结 leaf 报告的源码/运行时范围。最终 root 聚合运行记录 CLI
331 个文件、4,697 项通过；除相同 SQLite/Git 失败外，文件索引 worker 另有一项超时，
该所属套件单独重跑七项全部通过。聚合检查仍为失败。另以三个真实用量弹窗 Story
完成桌面/手机、明暗主题、打开及绝对/相对切换共 48 帧浏览器冒烟，交互和日期边界
检查全部通过；`usage-toggle-postmerge-final/report.html` 内嵌真实截图。该冒烟没有
合并前像素基线，不构成视觉等价结论。

五组件批次当前组件套件在 `NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test`
下 618 个文件、6,136 项全部通过，七个所属套件 112 项行为测试通过。最终 root
类型/lint/Effect/脚本阶段完成，聚合仍在 Node SQLite 支持检查及 Git 身份断言处停止
（CLI 332 个文件、4,698 项通过）。当前 Electron 应用构建通过，但真实冒烟因
`electron@44.9.3/path.txt` 缺失而在启动前失败，不构成新增 Electron 运行时验收。

旧列表续迁在集成前同样通过 618 个文件 /6,136 项组件测试。同步至 `ff17c0e68` 时，
唯一新增冲突位于 `pr-merge-button.tsx`：保留 StyleX，采用上游要求的 20px 紧凑高度
（`themeSpace[5]`），上游队列/auth 行为原样合入。两个旧列表实现与正式截图对应源码
字节相同。集成后 618 个文件 /6,137 项组件测试通过；根类型、typed lint、Effect lint
及脚本完成，聚合仍因相同 Node/Git 失败而失败（CLI 332 个文件 /4,701 项通过）。
独立合并后浏览器矩阵保留自己的源码范围，不替代正式 490 组的未决像素差异。
集成后的 362 组主要矩阵共 69,752 个节点，全记录字段相同；359 组 PNG 字节一致，
三组保留 27 个原始像素、两个阈值像素，最大通道差值六，仍未关闭。另 16 帧真实
浏览器冒烟验证桌面/手机、明暗主题的预期 20px 合并/diff 高度、方法菜单、squash
选择及 Escape。集成后 Electron 应用构建通过，实际启动仍受缺失二进制阻塞。

活跃列表/登录页批次使用从官方独立下载并以 SHA-256 清单校验的 Node 26.12.1，
未修改机器全局运行时。618 个组件测试文件、6,137 个测试全部通过；根类型检查、
类型感知 lint、Effect lint 和脚本测试完成，SQLite 运行时检查现已通过。总检查仍因
既有 Git 身份断言失败而未通过（CLI 333 个文件、4,725 个测试通过），不能声称全仓
检查通过。国际化、公开边界及其他静态边界检查单独通过。实际最终 Electron 44.9.3
构建和隔离 smoke 现已完成引导、代理配置、Explore 到本地聊天，并保留四张真实截图。
这是仅迁移后的应用运行证据，不解决历史 Explore 像素差异，也不替代组件配对验收。

### Onboarding、会话界面与最新 main 协调

归属批次实际移除 23 个工具类：Overlay 13→1、桌面布局 16→9、MarkdownTable 5→1。
保留准确的奶油色、局部 slate/spacing 变量、拖动条优先级、拖拽柄 alpha/transition
语义和表格命名外层 group 选择器。DOM、回调、hooks 与公开 API 不变。
WorkspaceCard 的真实 opaque StyleX 调用方探针证明迁移会改变优先级，因此保留六个；
Backdrop 因对应公开边界保留四个。搜索 13 个、会话面板 23 个继续保留：公开字符串依赖
`cn` 在两个参数顺序中解析冲突，以及 ring/shadow 组合。在全部保留的工具类下加无效
样式不计作迁移。

同步 `main` 至 `05a60e018`，保留直接删除本地项目、引导创建项目和计划消息队列行为。
退役上游已删除的确认组件及专用夹具/runner，不为旧截图配置复活旧 UI；历史图片不动。
非样式源码对照和归属测试确认上游 handlers、公开 props、编辑/IME、菜单及导航决策保留。

真实变量作用域截图暴露既有迁移错误：继承的 StyleX alias 保持根 ink，组件局部 CSS
变量却已要求不同颜色。队列和移动设置改用元素局部准确表达式及编译器 alpha mix，不改
共享 token；修复后的 24/8 对 scope 截图字节一致，紫色/绿色对根蓝色/红色的反例保留。
同时恢复完整 transition 属性列表和变量 fallback、队列 hover 媒体条件及 Clock3 原有的
`flex-shrink: 0`。Clock 候选的 108 对 PNG 虽一致，仍有 24 个渲染字段错误，已实际修复。

最新 main 验收采用 source reference：保持合并图和夹具相同，仅将四个 incoming-main
文件作为侧栏、移动设置、队列/pending 依赖单元恢复。它不是完整历史 main 构建。
最初仅三文件的参考构建因 main 队列缺少迁移版 pending 所需导出而失败；保留该失败并
纳入 main 原始 pending 文件，不造兼容桥。原始参考 6101、修复队列/移动设置 6103、
修复侧栏 6104 均不可变，源码哈希证明各最终构建中的消费者未变。真实移动夹具使用实际
hooks/atoms 和合成 command port；侧栏已有 no-op 回调及调度预览 slot 不能证明 daemon
写入、完整 router 或调度器端到端行为。

`main2-locked-acceptance.html` 汇集 638 对：234 primary、370 native、34 个调用方/
变量作用域 supplemental 控制。627 对 PNG 字节一致；11 对保留 60,911 个原始差异
像素，其中五帧的 38,282 个像素超过既定阈值，保持 **OPEN**。最新 main 子集为 330 对/
325 字节一致/155 raw/一个阈值像素，共 72,132 节点；另保留 1,104 个侧栏私有 writer
差异和 72 个 shadow/pending-alpha 字符串差异。实际几何/事件相同；sRGB8bit 探针仅
支持选定表达式等价，不替换原始字段，也不证明任意浮点/过渡等价。合计覆盖 110,206 节点。

较早归属子集保持 308 对/302 字节一致。四个桌面 Onboarding Back/Skip 仍有 camera/
paint 差异：两帧有 1,512 条不同节点记录／2,275 scalar fields，约 0.01px transform
传播至子节点；两帧记录字段相同但 PNG 不同。两次限定原源/最终源控制得到匹配的第三种
Skip 变体和匹配最终 camera matrix 的原源控制，没有复现任一正式整图。摄像机使用真实
rAF、DOM anchor 回算及小数截位，尚未证明栅格原因。通用完整故事序列两侧仍各为
12/32 帧及四个初始透明度 readiness 失败；独立 native 46/46 成功不关闭它们。Overlay
对两种 requested theme 都实际固定浅色，符合路由合同。

报告内嵌原始 PNG 和明确标注的派生差异图。完整合并曾超过 V8 JSON 字符串长度限制；
派生报告视图逐值保留公开比较器实际读取的全部字段，完整 native 快照及独立全字段证明
保持不动。失败采集、被拒候选和 Electron after-only 不计正式配对。
当前组件测试 620 文件／6,207 用例通过；类型、归属测试、格式和独立边界通过。根检查
仍失败于既有 CLI Git 身份用例（4,868 通过／一个失败）。最新 CLI 与实际 Electron
已重建，隔离四图 smoke 通过，属于 after-only，历史应用差异未关闭。集成审查未发现 P0/P1。
最终桌面环境逐项核对 SDK peer 与锁文件，包含 Zod 4.3.6；被替代的 combined 报告保留
较早的 peer 版本不匹配。组件截图证据不变，最终报告另以锁定环境重跑 CLI／桌面验证。

### 自有布局与主题叶组件

`leaves3-acceptance.html` 的证据由 316 对真实浏览器执行截图组装：172 对 primary 和
144 对独立 native 执行，其中 InfoBar 48 对、Outline Rail 96 对。计数区分实际采集来源，
UI 状态可以重合。316 对完整 PNG 全部逐字节一致，42,970 个报告配对节点的记录字段
相同，既定阈值像素差异为零。独立组装检查逐值保留 native 每行准确的 13 个比较器字段
以及原始 PNG 字节/SHA；完整 native 快照和全字段证明仍保留。144 对原始 native 执行
的全部记录字段也一致。另 14 组重合的 Skeleton CSS 观测比较 5,592 个节点和
8,753,714 项 CSS 属性，不另计截图对数或报告节点。覆盖准确根/子树间距、局部调色板输入、
嵌套主题作用域及真实 671/672/673px 容器。独立直接文件 HTML 审查核实全部 401 个
唯一 PNG、632 个正式截图来源及八个补充原图；搜索/过滤、原图指针与键盘操作、关闭清理
及 1280/390px 布局通过，页面错误和外部请求为零。被拒的指标标签与旧 HTTP 页面运行
保留为独立证据，只签收最终文件。

产物服务器也支持没有 `index.html` 的目录：缺失资源返回 404，避免打开不存在的
fallback 后崩溃。真实 HTTP 检查验证缺失资源请求后报告仍可读取且字节不变，同时
Storybook 既有 index fallback 保持正常。

另两对仅迁移后的调色板裁剪控制在真实生产控件上移除全部三个 palette 变量，等待有限
动画结束及四帧完整 CSS 稳定后，明暗 PNG 与同源普通状态逐字节一致。原始计算颜色
从 Oklch 变为编译器实际输出的 Lab fallback polyfill；这些字段保留，不称字符串完全
相同。三个颜色在 Chromium 的 sRGB／Display-P3 × unorm8／float16 采样中通道差为零，
不推断 float32、任意未来背景或过渡中间态。初始计算字符串相等断言的失败仍保留为
诊断证据。这两对运行时控制不计入 316 对正式迁移截图，也不属于其零字段差异声明。

Skeleton 被接受的 CSS 观测两侧各保留相同的 5,948 条已知控制台 warning。共享 primitive
仅传宽度的动态 size 调用被编译为 undefined height atom，由 StyleQ 报告；四处布局迁移
没有修复这个既有错误。最初严格控制台运行及非零退出保留为诊断证据，最终 observer
只对该精确消息分类，保留零额外错误、外部请求及采集失败。primitive 的真实 reduced-motion
CSS 停止呼吸动画，实际观察到零动画；正常动效下的呼吸未对比。窄屏 footer 原裁切不变，
没有隐藏绘制来获得相同截图。历史全部 OPEN，包括 638 对最新 main 报告的差异，均未
因此关闭或重新分类。

当前组件检查 620 文件／6,207 测试通过；类型、typed lint、Effect lint、脚本、格式及
独立边界检查通过。初始根 `pnpm check` 有 15 个 CLI 测试失败，其中 14 个遇到主机
commit signing 环境问题，另一个是既有 Git 身份断言。仅以命令局部
`commit.gpgsign=false` 重跑 CLI 后，4,868 个测试通过，身份断言仍失败；Git 配置与
产品行为未改，两次均不能称根检查通过。重新构建的实际 Electron 于
`2026-10-27T12:22:33.898Z` 通过四个界面并保留真实 after-only 截图；它只证明应用
冒烟，不构成配对回归，也不关闭历史应用差异。

### 连接选择、恢复提示与队列滚动

有效 ACP native 覆盖 44 对字节一致 PNG、7,108 个配对节点，全部 10,450,646 项记录
leaf value 相同。Queue 修正后的 native 矩阵 54 对全一致，另六对运行时根变量控制使
其 native／control 覆盖为 60 对、13,380 个节点，记录字段无差异。连接提示 36 对主要
PNG 和 920 个记录节点一致；另 12 组 CSS 观测覆盖 256 个节点、400,768 项 CSS 属性，
字段差异为零，不另计截图。

根主题意图与实际输入分别记录。ThemeProvider 在 commit 时覆盖原 Queue 和连接提示
故事的根变量，因此原故事帧不能证明自定义根变量覆盖；额外运行时控制在主题实际完成后
设置变量并在截图前断言值。Queue 六对根控制核实全部六个输入，连接提示探针核实根／
子树 ink。ACP 的根 650 字重／21px 输入实际生效。修复五项夹具类型错误后，发出的
JavaScript 哈希仍为 `7008b53e…9528194`；原始类型失败保留，不改变已编译基线行为。

最初 Queue native 矩阵保留三个滚动截图差异：21,670 个 raw 像素、19,234 个阈值像素，
虽记录字段相同。最终采集在每次 swipe 后等待真实 `scrollend`，核实末行位置及 hit chain，
并要求截图前后 CSS、几何和输入观察完全一致，双方重新采完全部 54 个状态。未改 Before
源码的两个状态在旧／强 readiness 采集中也变化，支持就绪条件解释，但未定位某个具体
浏览器调度 bug。原三个例外仍 **OPEN**，精确绘制触发未独立证明；不以产品补丁、mask、
子集替换或阈值变化隐藏。ACP 初始嵌套 Escape／JSON 体积失败，以及连接提示定位器
strict 失败（零截图、20 条失败记录）均单独保留。修正后的 ACP 路径实际观察到第一次
Escape 只关闭 tooltip，第二次才关闭 menu。

共享 Skeleton 最终比较 40 个尺寸状态／360 个节点，包括原始内联样式和 480 项计算
CSS 属性，渲染字段差异为零，176 条原始警告变为零。另有一项动画诊断差异：
light／320px／reduced-motion 的 state 1，Before 无动画，After 记录一个已 finished、
单次迭代、currentTime 为 0.01ms 的原生 CSS transition。原记录保留在
`leaves4-sizing-comparison.json`，不把全部观测称为相同。四对正常动效 pulse 截图将真实
动画暂停到 400ms，PNG 全部字节一致。不变的 UsageCalendarSkeleton 另检查 14 组重合状态：
5,592 个节点和 8,759,306 项 CSS 属性相同，原 5,948 条警告变为零。computed-only 状态
不增加截图，初始 null 候选不计最终通过。历史 OPEN 报告和原有裁切限制继续保留。

组件测试 620 文件／6,207 用例通过，UI 测试 25 文件／299 用例通过。Skeleton 的有状态
尺寸用例替代两个浅层 class／markup 检查，数量净少一个，但增加可观察的 rerender 覆盖。
根类型、typed lint、Effect lint 和脚本检查通过；typed lint 记录 20,506 项 warning、
零错误。CLI 为 4,868 通过及既有 Git 身份失败，不能称根检查通过。最终独立边界检查通过。
`leaves4-acceptance.html` 包含 330 对正式截图（226 primary、104 native），59,406 个
配对节点，PNG 全部字节一致；补充 pulse、初始和被拒证据不计入这些指标。直接文件
浏览器 QA 核实全部 457 个唯一 PNG、660 个正式来源和 20 个补充原图引用，区分原图与
派生 mask；搜索、过滤、原图指针/键盘访问、关闭清理及 1280/390px 布局通过，页面错误
和外部请求为零。真实 Electron 于
`2026-10-27T13:31:23.380Z` 通过四个界面，图片仅为 after-only，不构成应用配对像素结论。

Skills sheet 续迁把六处 Spinner 尺寸类与一处 label clamp 移入局部 StyleX，并删除
一处冗余 shrink，共从 `mobile-project-skills-sheet.tsx` 移除八处工具类。
AdaptiveTabStrip 保留全部 13 处：公开的不透明 StyleX 调用方必须维持原 utilities 层
的胜出规则。72 对主要截图逐字节一致，6,612 个节点的报告字段相同，无采集失败。
详情另采 18 次，其中六次为重复静止状态；组装为 84 个不同 key，不能称 90 个独特状态。
四帧详情保留 25 raw／0 threshold 像素差异，布局相同；`leaves5-acceptance.html`
保留这些 OPEN。另八对独立运行时变量／正常动效截图逐字节一致，514 个节点和
804,683 项 CSS 记录相同。
类型、49 项归属测试及格式检查通过；局部 lint 为六项既有 warning、零错误。
本批只处理 UI，未重跑根检查，不关闭既有 CLI Git 身份失败、历史 OPEN 或整体 PARTIAL。

Filter／Queue／Mention 续迁减少 29 处：FilterPillBar 6→0、MessageQueueRow 8→2、
MentionHighlighter 22→5。Filter 保留元素自身的完整 dark/light-scope 条件、局部
`--color-white`、静态 alpha fallback 及 color-mix 支持分支。触控仿真的 hover 保持
暗色静止填充，只有支持 hover 的设备使用 14% 填充；Queue 用自有行 marker 切换，
Mention 镜像保留内联几何和控件 API。
验收审查发现旧工具将箭头函数字符串当作真值，没有调用就绪谓词；现在实际调用同步
谓词。未改动的历史 PNG 不能证明这些函数字符串门禁曾执行。相同 Before 的真实 trace
观察到 accordion 几何已稳定但 opacity 仍为 0，随后变为 1；当前采集明确等待可见
opacity 和关闭后的卸载完成。旧报告及所有历史 OPEN 证据保持原样。
修复工具后 178 个不同正式配对（182 次执行、四个重复 rest）逐字节一致，
12,428 个节点的报告字段一致；六项 capture 反例和 63 项归属测试通过。另 16 对独立
native 截图的 1,276 个节点、2,013,732 项属性记录一致；`leaves6-acceptance.html`
内嵌原图和诊断限制。

Home／Project／Recurrence 续迁实际移除 22 处：Home 24→13、Project 16→7、
RecurrenceEditor 2→0，保留局部作用域、alpha fallback 及输入反馈。
`leaves7-acceptance.html` 收录 192 对正式截图，180 对 PNG 字节一致；12 个 Home 帧
虽记录的布局／字体相同，仍保留 50 个阈值像素并列为 OPEN。另 24 对 native PNG 全部
字节一致；类型及 47 项归属测试通过，故事纯类型修正保留相同 emitted JavaScript。

Editor／Terminal／Warning／Merge 再移除九处：Editor 5→2、Terminal 2→0、view 127→125、
Merge 19→17，保留局部变量及主题／焦点条件。178 对正式 PNG 全部字节一致，4,090 个节点
的记录字段相同；20 对 native 中 18 对字节一致，两个编辑器失焦帧仍有 90 raw／15 阈值
像素，虽记录字段相同，仍保持 OPEN。未修改 Before 的控制现分别复现原亮色、暗色
After 完整 PNG。限定为 16 张图的诊断有八对相同步骤 PNG 字节一致，包含真实 Send 的
11 节点卡片子树完整 CSS／几何相同；同页连续截图在没有活跃动画时也出现另六／七像素
变化。这没有证明原 36／54 像素差异的精确绘制触发，也不关闭两个 OPEN。
类型及 70 项归属测试通过；`leaves8-acceptance.html` 保留原图、控制及历史限制。

Composer／fallback／Sidebar 续迁实际移除 21 处：Composer 83→81、LandingView 4→2、
公开旧 Sidebar 324→307。警告颜色读取准确的元素局部 amber 变量及 dark／light-scope
条件；Sidebar 保留局部背景／前景变量、断点和私有 transition writer。公开调用方、
primitive 覆盖和 group／peer 状态仍作为兼容项保留。真实 selector 渲染失败进入生产
composer 边界，编辑及显式重试保留草稿；Sidebar 夹具验证公开适配层，不代表活跃应用
消费者。140 对正式截图覆盖 4,332 节点，139 对 PNG 字节一致；一个窄屏 palette 帧在
未修改的 composer 卡片左下 border／shadow 保留两个 raw 像素，零阈值像素。记录字段相同，
但精确绘制触发仍为 OPEN。四次限定对照在两端都复现原 Before 完整 PNG，56 节点的
完整 CSS／伪元素／几何相同，没有复现正式 After 变体。Playwright 隐藏光标在两端的
textarea 都留下相同空 style 属性，计算值不变。完整 Sidebar native 记录也相同；另四对
正常动效将真实 200ms 线性 gap／left 过渡暂停于 100／200ms，PNG 字节一致，截图前后
动画时间相同。四个归属套件 24 项测试、组件类型、局部 lint 和格式通过，未重跑根检查。`leaves9-acceptance.html` 保留原差异帧和历史 OPEN，
与正式计数分别展示。

Composer 表面／分享布局续迁移走八处编译器已计数工具类，以及 22 处此前未解析的
`LAYOUT` 字面量工具类。Composer 保留暗色边框 60%／70%、oklab fill 90%、完整 HSL
fallback 与 supports 条件。mention 的不透明遮罩单独保留 sRGB input／background mix
和 input fallback，定义在实际绘制 wrapper 上。完整拖入颜色状态保留暗色原静止 fill／
边框，同时叠加 ring。分享布局保留固定圆角、标题尺寸和元素局部 spacing，五个 ring／
shadow 兼容类不动。共享 Token、公开 composer surface 字符串、DOM 和事件均不变。

`leaves10-acceptance.html` 包含 124 对正式截图、7,796 个节点，记录字段相同且无缺失／
采集失败，122 对 PNG 字节一致。两个原 Composer 帧保持 OPEN：未修改 fixture 按钮上
123 raw 像素；另一帧 531 raw 像素，包含迁移卡片角部两个阈值像素及 fixture 按钮
529 raw 像素。独立 native 12 对中 11 对字节一致，742 节点相同，截图前后共 712,320
普通 CSS 值及 1,424,640 伪元素 CSS 值一致。其 531 像素例外是同一原状态，不能另计
独特故障。一张未修改 Before 控制复现该完整 After PNG，但未证明具体绘制触发。
真实 150ms session 颜色过渡暂停于 75／150ms 时 PNG 字节一致。fixture 控件向生产
handler 派发浏览器 Files 事件，不代表 OS 拖放或上传服务验收。类型、20 项归属测试、
局部 lint 和格式通过，未重跑根检查。

像素一致也暴露既有验收缺口：分享卡片七个产品色 alias 在 app 根解析，背景／标题／
metadata 会跟随 app 而非所选卡片调色板。32 对布局字节一致只是保留该回归，不证明
调色板隔离正确；下述独立修复使用完整局部主题，并与迁移前源码参考对照。
Composer 的局部浅色 mention 遮罩也可能与继承的 frame alias 不一致，此状况在 Before
已存在，本批保留。无 chip 的 dialog 仍使用 MentionInput，不证明 plain textarea 分支。
历史 OPEN 和原始截图保持不变。

分享卡片修复在实际卡片作用域上，沿用既有 product／conversation 调色板，并绑定完整
`scopedThemeColors` 与 `scopedThemeSpace`。两组与 `defineVars` 共享未变的 canonical
默认值，在卡片颜色及 spacing 变量处重新解析 alias。caption 同时恢复原四边 border
color fallback 与 supports 内 70% oklab mix。这修复调色板、logo 尺寸和间距泄漏，
不逐元素硬写七种颜色，也不改变全局默认值。

`leaves11-12-acceptance.html` 的 72 对正式截图中，32 对以真实迁移前 Tailwind 源码
`b84e18308^` 为参考：PNG 全部字节一致，覆盖 1,672 个记录节点。native 参考比较的
384 个角色节点、11,136 个 CSS 字段及 2,304 个变量值也精确相同，252 项语义检查通过，
document 根状态不变。与紧邻的错误 Before 对比则有 26 帧按预期修复、六帧相同；
它们属于修复证据，不是迁移等价失败。另八个未改消费者控制的 348 节点记录字段一致，
但仅七张 PNG 字节一致，剩余 scoped-palette 帧有两个 raw／零阈值像素，精确栅格原因
未证，保持 OPEN。被拒的调色板／spacing／
border 候选和历史差异均单独保留。

Spinner 续迁使用 primitive 自有 `diameter` prop，避免调用方 StyleX 宽高类竞争。
数字是像素，CSS 长度可读取局部 spacing；显式零生效，省略恢复命名尺寸，SVG 宽高
属性仍属于 glyph。真实保存中编辑器及合并中控件删除四个尺寸工具类。
合并报告中 Spinner 正式 40 对 PNG 字节一致，覆盖 1,116 个记录节点；另 12 对
native PNG 字节一致，176 节点的 168,960 个普通 CSS 值及 337,920 个伪元素 CSS 值在
截图前后相同。DPR 1／2 将真实 900ms 旋转暂停于 400ms，验证 3／6px spacing 作用域，
以及 16→0→命名 24→14 更新时同一 SVG、wrapper 和 animation 对象。34 条新增内联
变量／空 style 记录明确保留，不称原始 DOM 完全相同。浏览器身份检查针对真实 SVG，
forwarded-ref 回调由行为测试覆盖。UI 归属 38 项、调用方 31 项测试及两个包类型检查通过，
未重跑根检查；这些矩阵不关闭历史 OPEN。
合并 HTML 在明确标注的缩略预览后按 SHA 内嵌未改的完整 PNG。独立素材解码及两个
连续的真实 Chrome UI 循环通过；CLI 控制器重置／卡住及一张未稳定 UI 绘制变体保留为
诊断证据，精确原因未证，不归因为 OOM。

后续 Spinner 调用方批次在认证、移动控件与其他加载界面的 17 个生产文件移除
48 处已计数宽高工具类。各处通过 primitive 自有 `diameter` 表达式读取实际局部 spacing；
margin、shrink、颜色和交互类保持原所有权。132 对正式截图全部 PNG 字节一致，覆盖
6,848 个记录节点：认证 40／2,692、移动端 48／2,964、杂项 44／1,192。
42 项归属测试、组件类型及局部 lint 通过（227 warnings，零 errors）。长 reconnect
故事的八帧裁剪标记作为夹具限制保留，不计可见状态覆盖；独立 ActualControlsReconnect
夹具在可见区域挂载生产第三分支。合成 pending 回调不调用账户或认证服务。

密码／账户续迁在三个生产文件再移除 20 处 Spinner 尺寸工具类。密码提交状态
16 对正式 PNG 与 576 个记录节点全部一致；账户状态 44 对与 4,660 节点一致。
另八对账户关闭动效保留真实暂停的 WAAPI 动画状态与 pending 标记；两对删除画面
通过合成 Capacitor iOS 身份挂载实际生产分支。十对补充截图均 PNG 字节一致，但身份
仿真不代表物理 iOS、WebKit 或原生壳验收。两项账户归属测试与组件类型通过。

Monaco wrapper 的两处自有尺寸工具类迁入局部 StyleX。八对正式截图的 PNG 字节及
2,342 个记录节点均相同；门禁针对实际正面积主滚动条，先通过真实 editor hover 观测
可见，再 hover 外部行号锚点，等待 hidden class／opacity／无运行 transition 连续四次
新采样稳定。原 280 个变化像素精确符合实测 slider 颜色的物理像素叠加，残差为零。
原始与 settled 差异仍展示为诊断；拒绝的 SHOW 门禁每侧零帧／四次失败也保留，原因是
它错误包含零尺寸 hover-widget 滚动条。没有修改产品 CSS 满足门禁。故事在两种 app
主题下均使用 light editor，不声称覆盖真正暗色编辑器语法。

`leaves13-14-acceptance.html` 合并 200 对 PNG 字节一致的正式截图与 14,426 个记录节点，
跨 20 个不同生产文件移除 70 处已计数工具类。40 对补充包含 27 对原历史 OPEN、十对
账户动效／平台身份、两对早期 Monaco 差异及一对被拒门禁错误截图，与正式结果分开。
历史 OPEN 原图保留来源哈希及尺寸；新批次相同不将其关闭。离线 HTML 使用有明确说明的
有界预览，并保留未改动的完整原图供检查。

Popover 续迁在实际 Popup 的 panel StyleX 规则之后增加有限 `padding`／`gap`
选择（`default` 或 `none`）。Positioner 的 ref、style、事件和定位契约仍属于外层节点。
五个生产调用文件的七处 Popup 迁移八处零内边距／间距工具类，保留宽度、shadow、
overflow 和非零 padding。`leaves15-acceptance.html` 的 68 对正式 PNG 与 4,416 个
记录节点全部一致：primitive 40／1,272，实际消费者 28／3,144。浏览器覆盖默认、零值、
同节点恢复、container／强制主题及真实内容控件。另四张仅 After 的 Gallery 图验证
实测布局读数；其 36 条 SSR styleq 警告在两侧源码基线均存在，仍未修复。
UI／Gallery 28 项测试、消费者 60 项测试、包类型通过；typed lint 299 warnings／零 errors，
九个变更文件格式检查通过。

消费者主题限制明确：五个故事遵循两种请求主题，SenderProfile 固定亮色，桌面回合配置
固定暗色。初轮资料卡故事的 play 最终留下关闭状态，导致四次门禁失败；正式 profile
通过真实 Escape 与头像点击建立打开状态，拒绝证据保留。14 项实际调色板／padding／gap
观测在两侧一致。独立诊断在最后观测后没有完成 cleanup，被中断；原因未证，不声称
浏览器清理通过或归因 OOM。正式截图采集完整成功。报告保留 27 对原历史 OPEN 及其原图。

后续 Spinner／Popover 批次移除 24 处已计数工具类：Spinner 尺寸 18、Popup 尺寸六，
涉及十个不同生产调用文件及共享 Popover API。`width`、`minWidth`、`maxWidth`、
`maxHeight` 通过受 guard 的 StyleX 动态值作用于实际 Popup；零生效、省略恢复默认，
Positioner 的 style／ref／事件归属不变。另删除早期 `b84e183084` 迁移引入的十处重复
静态 StyleX spread，保留完全相同的显式合成 className，归属构建已无这些重复属性警告。

`leaves16-17-acceptance.html` 包含 144 对正式截图与 9,348 个一致的记录节点：
History 48／2,776、Session Spinner 36／2,584、Popup API 32／844、消费者 28／3,144。
其中 143 对 PNG 字节相同；一张实际强制暗色的消费者原帧在未改的顶部 tab 边缘保留
五个 raw、零 threshold 像素。有限诊断中 329 个实际后代的 157,920 普通及 315,840
伪元素 CSS 字段一致，1,016,441 个变量字段的并集仅新增预期的 Popup width 变量。
一次未改源码的 Before 控制截图精确复现 After。这些证据缩小范围，但没有证明精确
栅格触发原因，原差异仍 OPEN。另 27 对历史原 OPEN 与被拒门禁原图、仅 After 的 Gallery
证据分别保留。

被拒门禁明确记录：resolve 确认在 pending 回调完成前关闭父 History Drawer，须实际
重新打开；unknown-sharing 有两个真实 Spinner；`.25rem` 不是 `.25px`；block 的
作者态 auto min-width 计算为 0px。修正就绪条件保留这些产品行为。Header／side-panel
窄故事保持固定最小宽度，不代表完整产品响应式验收；身份卡使用合成回调，不调用后台。
UI 类型及 28 项 UI／Gallery 测试通过；主归属测试 49 项、最终 typed lint 276 warnings／
零 errors。独立 Session 归属验证 121 项、History 六项通过，范围有重叠，不相加为唯一
测试总数。Gallery SSR 警告保持原数量，未重跑根检查。

Project／About／Menu 续迁在六个调用文件移除 21 处已计数工具类：Spinner 尺寸 12、
Menu bounds 九。Menu 为实际 Popup 增加 `minWidth`／`maxWidth`／`maxHeight`，支持
px 数字、CSS 字符串、显式零及省略恢复，保留命名 regular／compact 宽度与 Positioner
ref／style／事件。覆盖六个实际菜单节点；Header Opened sessions 子菜单三处 bounds
保留，等待实际生产组件夹具。

`leaves18-19-acceptance.html` 保留 164 对正式截图／11,688 一致记录节点：Project
56／3,032、About 32／3,024、Menu API 44／1,432、消费者 32／4,200。其中 162 对
PNG 字节相同；两张强制暗色 Owner 窄帧共享父 Change owner 高亮行的四个 raw、零
threshold 像素。281 后代诊断的 134,880 普通及 269,760 伪元素 CSS 字段一致，
869,974 变量字段仅五个预期 bounds 变量有意不同。一次未改源码 Before 控制精确复现
After，但精确栅格触发未证，两张原帧仍 OPEN。此前 28 张原 OPEN 对照（含五像素 tab
帧）另行保留。

Fork 原焦点 Tooltip 遮挡其他菜单行；正式 profile 真实聚焦末行保证完整可见，原图保留。
初始错误故事 ID 仅选择 20 帧，正式完整选择为 32。About 原 0／24 次不支持 native-theme
订阅失败保留，只补合成 bridge 后重建 Before。About updater IPC 和 Project CloudApi
均为合成边界，不声称真实安装、后台、worktree RPC 或 GitHub 授权；Community 窄行原有
拥挤保持。两张 Gallery 及四页实际 OSS Electron smoke 为独立仅 After 证据。当前 UI
构建通过、复用已有 CLI 产物，隔离 smoke 清理完成。UI 53 项、主归属 34 项、包类型及
七文件 lint（164 warnings／零 errors）通过；独立 About 23／Project 16 项不相加为
唯一测试总数，未重跑根检查。

Integrations／Ceremony 在两个生产文件移除 11 处已计数工具类：六处 Spinner 尺寸
通过 `diameter`，Ceremony 根五处 fixed／inset／z-index／overflow／slate ink
通过局部 StyleX。Storybook 显式使用 `VITE_LODY_PLATFORM=cloud` 与合成 public
Auth／org／CloudApi 数据，OSS composition 及真实 auth／network 行为不变。实际
onboarding 路由拥有 light 主题，dark host 属压力覆盖，原低对比保留。

`leaves20-acceptance.html` 记录 96 对正式截图／4,344 一致节点：Integrations
56／3,392，Ceremony 40／952。仅 94 对 PNG 字节一致；两张 narrow-dark Ceremony
共享同一差异图对，各 379 raw／42 threshold 像素，精确绘制触发仍 OPEN。有限
17 节点诊断的每快照 77,232 个 CSS／变量／双伪元素记录、几何、hit stack、ink 及
动画状态一致，前后稳定；图片 bytes 相同，唯一未改源码控制复现原 Before 而非 After。
这些观测不能证明视觉等价。此前 30 对原 OPEN 另行保留，不用 CSS 补丁或 antialiasing
假设关闭。

Ceremony 夹具以 reduced-motion 暂停电影、排除音频；实际 Skip／Configure 控件及
480ms 完成回调被观察，不代表完整 normal-motion 时间线。Integrations 初轮 40 帧／
16 次 resolved 门禁失败保留：英文 Manage 被误认成 Connect，仅修 profile。
Integrations 11 项缓存测试／类型，以及 Ceremony 两项主题生命周期测试／类型／
零警告局部 lint 通过。所有正式捕获保留原 harness 哈希及源码副本；后续可选 click
按钮参数不追溯改变来源，未重跑根检查。

ContextMenu 为实际 Popup 增加受 guard 的 `minWidth`／`maxWidth`／`maxHeight`，
支持 px／CSS 值、零和省略恢复，保留 Positioner 的 ref／style／事件。六个私有行菜单
移除六处最小宽度工具类。56 对真实右键截图全部 PNG 字节一致，覆盖 10,212 记录节点：
primitive 32／1,040，消费者 24／9,172。另两张 Gallery 图通过实际鼠标右键验证 light／
Vesper bounds，仅为 After。UI 54 项、归属 34 项、包类型及八文件 typed lint
（170 warnings／零 errors）通过。harness 仅新增可选 `click.button`，默认 left，
以派生哈希识别本批，不重写早期保留源码。历史 OPEN 不关闭。

Button 在命名 size／variant 之后增加自有 `width`／`height`，支持数字 px、
元素局部 CSS 表达式、零及省略恢复。移除 38 处：十个 mobile／leaf／auth 文件 30 处，
三个私有文件八处。后者是五个 JSX 调用点、四个实际 Button 节点：一个 Header 触发器、
Reply 卡片／Dialog 及 Plan Copy。Search 四处、Finished Copy 两处、未挂载 Login
四处与 opaque 公开调用方保持原样。

`leaves21-22-acceptance.html` 合并 228 对正式 PNG 字节一致截图及 18,056 一致记录节点：
ContextMenu 56、Button API 40、mobile／leaf／auth 100、私有调用方 32。另四对真实
按住鼠标 active 截图，在 reduced-motion 下完整 CSS、双伪元素、焦点、几何和动画记录
一致；新增 16 条私有尺寸变量记录及八条 root class／style 差异属于明确保留的变化，
不代表 normal-motion 时间线覆盖。32 对历史原 OPEN 独立保留，仍未解决。

私有 Before 是逐项审计的 32 帧原成功截图子集，没有重采。初始 52 帧计划的八次门禁失败
与六处延期工具类保留：Search 需要 searchbox 门禁，Footer 原故事从未显示 hover 控件。
此前语法／portal／祖先门禁和本地导航失败均保留；仅修 profile、以未改源码的新浏览器
重采建立接受矩阵，不声称已证明 OS／browser 原因。Gallery 仅 After；首版 Button
读数触边候选明确拒绝，与既有 Sample 列布局修正分开。完整组件回归通过 620 文件／
6,207 测试，UI 25 文件／302 测试；包类型与归属检查通过，未重跑根检查。

随后两个调用方批次通过既有 Menu／ContextMenu 与 Button API 再移除 32 处，
没有新增 primitive API。六处剩余右键菜单 bounds，以及现在真正可见的 Opened／Search／
finished-footer 控件占 15 处；消息动作与 Mermaid／MobileAdd／UsageClose／Loro 恢复
占 17 处。Mermaid 四个控件一起迁移，reset 在原 min-width 之上保持自动宽度，高度读取
元素局部 spacing。Loro 方形默认值属于模块私有 helper，其四个内部调用点验证与迁移见后文；
其他 opaque 公开兼容边界仍保留。

`leaves23-24-acceptance.html` 记录 **176／176 对 PNG 字节一致**，以及
**19,996 对节点记录：19,993 一致、三条不同**；仅 173 帧原始记录完全一致。三条原差异
是空且 `visibility: hidden` 的 xterm 辅助节点高度 0↔300，其他字段相同。有限 48 次
观测在两构建都复现两种高度，可见 viewport／scroll range 不变；另四对真实截图一致。
原始记录不改写，32 对历史原 OPEN 仍未关闭。

另八对实际 Chromium 触控／复制反馈截图一致，涉及 292 节点、1,371,394 CSS 记录；40 条私有尺寸
变量及 24 条 root 属性变化明确保留。接收器是合成实现，不是 OS 剪贴板；受控
1199／1200ms 边界属于 reduced-motion 证据。Mermaid 以真实 SVG 克隆驱动生产 Viewer，
不代表 parser／native 手势验收。原有窄屏 Usage 裁剪和侧栏故事拥挤保留。拒绝的选择器、
加载及导航候选与接受阶段分开；未冻结的 23 批初始 profile 只重建语义，不追认原 bytes。
24 批接受捕获 bytes 与格式化 profile 有哈希追踪且语义一致。包类型与局部 53／39／68 项
测试检查通过；各范围重叠，68 项由三套初轮通过加移除两条旧 Tailwind 类断言后的
Mermaid 重跑组成，未重跑根检查。

primitive invariant／私有 Fork 批次在十个产品文件再移除 18 处：16 处重复了
primitive 已拥有的声明；两处是仅有两个内部调用点的模块私有 Fork helper 默认尺寸。
后者使用既有 Button 尺寸 API，保留调用方覆盖，没有增加通用样式逃逸接口。

`leaves25-acceptance.html` 独立记录 **72 对 PNG 字节一致、4,222 对节点记录一致**：
invariant 40／2,658，私有 Fork 32／1,564。另 **44 根／68,837 属性值只是 computed
证明，不增加 PNG 配对**；computed、几何、raw style、disabled／text 及匹配 primitive
声明一致，raw class 仅有预期 16 处移除。四套归属测试／62 项通过，不代表 Fork helper
全 CSS 覆盖，也没有新的 Electron／Gallery 截图。

helper 原始 23 成功／九失败保留：八次用了错误的 legacy Spinner 选择器，一次在
Storybook 就绪前超时。computed 两轮早期尝试也保留，包括已有 22 条记录后的 timeout；
精确 browser 原因尚未证明。接受阶段以明确门禁及未改产品构建完成，没有 CSS／timer
补丁。32 对历史 OPEN 和更早冻结报告仍未关闭、未改写；未重跑根检查。

随后 invariant／私有页脚批次在八个产品文件移除 14 个已计数 utility：十个重复
Spinner 声明、两个 Loro 尺寸，以及消息行的原生操作隐藏／Avatar 默认值。Loro 的
`IconButton` 仅供模块内四个调用点使用，先前“公开 helper”的分类错误；公开
`SidebarChatRow` 兼容边界保持不变。

五个私有内容间距 utility 保留在 `ai-gui/view.tsx:8495`、`:8500`、`:9325`、`:9341`、
`:9390`。被拒候选输出的逻辑方向 margin 正确，但完整构建将 reverse writer 与
priority-zero 根变量归组，最终输出为无层级规则，导致实际子元素 utilities 层 writer
失去胜出权，起始 12／9px 变为末尾 12／9px。独立 writer-only 编译探针缺少该归组，
因此结论误导。局部 layer 条件嵌套在自动 StyleX 层内，不能复现原 root layer。
五处已恢复，原真实浏览器探针的字段与 PNG 再次一致。共享归组／层级行为需作为独立
单元评估并广泛回归消费者，没有宣称上游官方确认缺陷。

`leaves26-acceptance.html` 记录 **136 对正式截图：134 对 PNG 字节一致，9,782 对
节点记录一致**。Spinner 占 48／3,042，消息控件 40／2,616，Loro 48／4,124；矩阵包含
未改动的间距控制组。另四对正常动效将真实 CSS animation 暂停在 400ms，6,270 个
Spinner 与 150,288 个 Button／伪元素属性值一致。有限 Owner 菜单复采中，162 节点／
两个阶段的 1,471,622 个渲染值及 PNG 一致，但没有替换原正式帧。

两对正式 OPEN 保留：原生音频控件 987 raw／567 threshold 像素，Owner 转移处理中
24／四。32 对历史 OPEN 与另外七个原始诊断也继续保留：Project 头像一对、正常动效
四对，以及被拒间距候选的音频两对。后续资源／过渡就绪和相同复采不能证明原始绘制触发
原因。报告保留原图与 raw 差异 mask，没有把 threshold 为零当成通过。Chromium 手机
模拟和合成产品 props／callbacks 不代表原生设备、播放／后端流程或未访问路由均等价。

精确的 `d951` Before-view 字节来自保存的 `c618` 第25批 Before，加上该批三个已知
修改重建，SHA 与独立记录的 Before26 指纹一致；这不是采集时保存的原始源码备份。
被拒的门禁／夹具阶段与资源 deadline 失败均独立保留。各自归属检查通过：view 六套／
58 测试、Loro 两套／26、Spinner 四套／28，以及包类型、范围内格式与 lint（224／19／
220 warnings、零 errors）。范围存在重叠，没有累加成独立覆盖数；未宣称新的根检查或
Electron／Gallery 运行。

随后 Sidebar／ManagedPreview／私有 Card 批次在三个产品文件移除 16 个 utility。
Sidebar 只移除三个内部普通默认值；原拟十处在真实 DOM prototype 改变外层祖先与
公开调用方胜出关系后缩小范围，其余七个 gap／border／radius 项和原先已排除的
floating shadow 继续保留。ManagedPreview 使用既有 Spinner diameter API，并移除
重复 Cancel shrink。私有 `CollapsibleCard` 仅有三个内部调用点，以私有
`containerStyles`／`bodyStyles` 在同次 StyleX props 中与 base 显式合并；Worktree
保留继承的 bottom 间距别名，Tool padding 与 activity radius 保留元素局部变量。
space-y writer、搜索 ring／shadow 兼容及公开控件 API 不变。

`leaves27-28-acceptance.html` 记录 **192／192 对正式 PNG 字节一致、9,684 对节点
记录一致**：Sidebar104／6,736，Managed32／904，Card56／2,044。另二十对实际
Sidebar 调用方截图中，18 对一致、两对原始 OPEN（2／93 raw 像素、summed RGB12
以上为零），选定的 180 节点 CSS／伪元素／变量记录均一致。更早三个窄范围 prototype
原始差异也保留 OPEN（5／2／2 像素），新的产品成功截图不能关闭它们。另四对 Managed
正常动效在真实 animation400ms 一致，涉及 3,840 个普通 CSS 值。prototype 反例、
错误设备 Before 十二次门禁失败、Managed Cancel／raw spacing 假设，以及初版 Card
matched-rule reader 漏项均独立记录。

Managed 采集使用真实 credentialless sandbox iframe、产品 inspector 解析、实际目标
点击、草稿取消／重开和保持 pending 的合成 public writer，不代表 runtime／后端／原生
设备流程。Card Worktree 仅验收真实终端 step header，没有声称未挂载 output 已覆盖。
真实直接 ThoughtCard／搜索调用方也不代表 assistant builtin／DeepSeek SessionMeta
搜索整合完成。Sidebar 九项测试来自相邻 primitive／focus 两套，而非并不存在的直接
Sidebar 单测；Managed15 和 Card82 归属测试、包类型及范围格式／lint 通过（3／5／224
warnings、零 errors），没有将重叠范围累加为独立覆盖。

冻结的第26批报告继续保留 32 对历史、两对正式及七对诊断原始 OPEN。该 41 对 compact
index 不是全项目穷尽清单，早期 main／leaves4 等报告仍未关闭或改写。本批新增五对补充
原始 OPEN、零正式 OPEN，也没有新的 Electron／Gallery 或根检查声明。

消息动作／Billing 续迁再移除 25 个 utility：七个固定 ghost Button 各三个颜色，
两个 Billing Spinner 各两个尺寸。Button 既有实现／默认值不变，仅新增标准 token 模块
导出。完整局部主题显式继承 50 个非目标 Button／语义 token；使用范围只有固定 Lucide
图标或旧 Spinner wrapper，不含任意子节点。局部 Button 主题曾因重置继承 gap 与焦点
ring 被拒；新建三颜色角色 API 仍只是研究。最终使用既有 token 组保留 fine／coarse
hover 胜出关系与元素局部 legacy 变量。

`leaves29-30-acceptance.html` 记录 **168／168 对正式 PNG 字节一致、17,216 对节点
记录一致**：消息动作 120／13,208，Billing 48／4,008。消息矩阵保留 112 对原始帧，
另用八对精确状态就绪帧；原有 119 raw／113 threshold 像素的 Copy／Check 差异继续展示：
pending Fork 门禁遗漏了同级复制反馈重置，未改产品 timer／CSS。另八对 native 默认／
局部主题帧的普通 CSS、伪元素与图标子孙一致；50 个非目标 token 的 46,800 个记录值
一致。三个改写输入仍有 1,092 个原始 token 值差异，不声称所有变量相等。

四对同元素原 token inline 压力帧各有 673 raw／672 threshold 像素差异。Before 物理
Tailwind 颜色压过 primitive 输入，After 局部主题允许更强 inline 输入影响颜色；这是
真实 CSS 不等价。当前七个源节点不开放 style／token／child props，私有 Fork 两个
调用方只传 opacity／margin 类；支持的祖先主题合同另行保留与验证。该主题不能推广到
任意 Button 或读取 `colors.label` 的子节点。负控和单幅 compiler／DOM clone 研究图
均独立于正式产品前后对照。

Billing 使用真实组件预览、取消／重开与保持 pending 的确认操作，provider 为合成公开
合同，不是 Stripe／认证／后端 E2E。四对正式补充动效在真实 animation 400ms 一致，
包括 3,840 个普通 CSS 值及明确的 dialog／祖先绘制状态。更早四对字节相同但近透明的
弹框图被拒，原精确 opacity 未记录。初始可访问名称门禁及 native runner／清理失败
独立保留。此前 27–28 五对补充 OPEN、第26批非穷尽 41 对 compact index 与更早报告
均未关闭或改写。

消息动作三套／39 测试、Billing 两套／30 测试，以及范围内类型／lint 通过（224／36
warnings、零 errors）。components 全量 620 文件／6,207 测试通过，但 view 在运行中从
pre29 改为候选，明确是 mixed-source，不代表冻结最终29全量覆盖。UI 25 文件／302
测试在不变的记录源码上通过。提交审计根 `pnpm check` 在 ACP adapter 准备阶段因
32 个 SDK export 路径解析失败停止，后续步骤未运行，也未扩展无关 ACP 工作。根
`format:check` 通过但不覆盖 components／UI；另查 313 个改动文件，20 个视觉 JSON
profile 有格式问题，产品源码无失败；证据 profile 暂保持冻结。隔离 47 文件 manifest／
patch 树的 offline lockfile-only 验证未改变锁文件，导出不需要依赖变更。检查前 315 个
dirty 文件哈希全部保持不变。

Panel／iframe／搜索续迁实际移除 26 个 utility：面板 header／rule／title／body
15 处、managed iframe 五处、两个固定 SearchBar Button 模板的颜色六处。
面板 Frame／背景／字重兼容项保留；搜索保留 disabled ink `/40`、圆角与过渡。
值仍在元素局部求值；iframe 除新增样式块与单处 class 赋值外，生命周期、安全属性及
preload 字节不变，没有新增 primitive 默认行为或 token 组。

`leaves31-33-acceptance.html` 记录 **168／168 对正式 PNG 字节一致、12,024 对
节点记录一致**：panel 56／2,180，iframe 32／904，search 80／8,940。Panel
native 另有 216 个角色快照／314,928 值，不是独特 DOM 数或新增截图。Iframe 在
64 张原始完整 PNG 的 192 个预声明点核验真实白／青色；三对额外 native PNG 与
8,676 个 CSS／伪元素／运行时值一致。接受的透明 synthetic 文档匹配 child scheme；
原 dark v1 虽 computed cyan 却实际绘成白色。同一 frame 仅改 child scheme 的诊断
使白→青，此实验和失败 v1 原图与正式产品 Before／After 分开。

搜索覆盖真实输入／前后循环／清空／Escape、Close 卸载／重开、键盘焦点、按住鼠标后
移出释放及 coarse sticky hover。States 标题 42／128 实际被 clamp 为 5／5，完整
故事确达 128／128。八对支持范围内 native PNG、181,640 个普通 CSS 及 72,656 个
根伪元素值一致，包含实际图标子树。十二场景的 50 个非目标 token 保留 28,500 值相同，
三个目标输入仍有 940 个原始字符串变化。四对同元素旧 token inline 负控各变
392 raw／392 threshold 像素，合计 1,480 普通 CSS／1,156 伪元素字段变化，属于
真实 CSS 不等价。当前 SearchBar 不转发视觉／style／任意子节点，三个生产调用方仅传
height-only rootFill；该私有主题不能推广成任意 Button／祖先覆盖合同。

人工祖先 prototype 仍非正式证据：fine computed ink 改变但两对 PNG 一致；coarse
选定 ink 相同而一个 phone-light 原图对有两个 raw 像素，未推断绘制原因。Panel 三个
谓词失败、iframe v1 和搜索已存截图／cleanup 挂起均保留。最终 native 数据完成后才
停止两个清理进程，不声称正常退出。局部检查通过：panel 26 测试、iframe 15、search
30，以及类型和格式；lint 为 7／1／120 warnings、零 errors，重叠范围不构成新全量／
根检查。离线报告完成所有原图／预览解码及连续两轮 1280／390 Chrome 交互 QA。
更早冻结 29–30／27–28 的负控与 OPEN 索引不变、并非穷尽；没有新增 Electron／Gallery
验收声明。

固定 ink／项目选择器续迁移动十个源码 utility：Operation reply／Header More 三处
颜色，以及七处 group 图标声明。颜色主题只改 `ghostLabel` 与语义 `colors.label`，
其余 51 个 token（含 `ghostHover`）继续继承；背景与控件默认行为不重设计。被 render
合并丢弃的第二个 More JSX 子节点仍保留旧 class。Group 图标保持元素局部 spacing／
opacity、自有 shrink0／fallback shrink1、fallback 的 16px flex 槽及真实公开调用方覆盖。

`leaves34-35-acceptance.html` 为**视觉部分验收：108 对正式 PNG 中 105 对字节一致，
三对当前 OPEN；5,264 对标准节点记录全部相同**。Ink 占 48／2,992，selector
60／2,272。Selector 最终逐行引用 48 对未变的原 closed 状态及十二对真实已绘制菜单，
保留原 manifest／key／PNG／layout 来源，不伪造 capture manifest。四对 natural 菜单
保持实际 70% opacity，不用 caller 遮蔽该迁移值。原门禁在 popup opacity0／
translateY(-4px) 时接受已挂载几何；只修 readiness 要求实际 opacity1／identity／
无生命周期标记或 pending 有限过渡，没有产品 CSS 补丁。

三对当前 focus-ring 角部仍有 14 raw／零 threshold 像素；六对原始菜单另有
24 raw／零 threshold 像素，两组均 OPEN。像素在迁移 glyph 之外；限定八张 PNG／
197,883 值的 ring 探针保留三个 desktop 截图前 transition 声明差异，同源重复稳定，
截图后 map 与完整几何相同。这不证明精确绘制原因，也不关闭原始或当前差异。Selector
还验证 disabled 可聚焦但不激活、键盘选择、移除 caller 和 44 个 SVG 快照，不另计正式图。

八对支持范围内 ink native PNG、160,608 普通 CSS 与 68,832 根伪元素值一致。
十二场景的 51 个非目标 token 保留 25,704 值相同，两个目标输入有 456 个原始值差异。
四对同元素旧 token inline 负控真实变色（按调色板为 975／966 raw、744／740 threshold），
背景与原 token 输入仍相同。当前固定子节点且不转发 style／token 的边界限制采用范围，
不能推广为通用 Button skin。两端 native checkpoint 完整后清理挂起，精确工具原因未证，
不声称正常进程退出。

Ink 16 项、selector 14 项归属测试、类型与范围格式通过；lint 为 3／5 warnings、零错误。
报告保留 raw 差异及派生 mask 标签，独立核验原图来源／哈希／解码，完成连续两轮
1280／390 Chrome UI QA。更早冻结报告哈希、全部历史 OPEN 和负控不变；合成 public
组件夹具不代表完整后台／runtime／原生设备，也没有新增整个项目、根检查、Electron 或
Gallery 通过声明。随后稳定源码 UI 回归通过 components 620 文件／6,207 测试及 UI
25 文件／302 测试。2,364 文件快照在启动后记录，全部产品 owner 已提前冻结；快照后无
源码变化，但启动至快照的间隔仍是明确限制。此后续证据不关闭像素 OPEN 或无关的根 ACP
准备阶段失败。

控件尺寸续批通过现有 primitive API 移除二十处 utility，覆盖文件错误操作、附件菜单、
桌面运行配置 bounds 与预览连接状态。精确局部 spacing 表达式保留子树读取；紧凑子菜单
通过一个私有共享 bounds 对象传入五个真正渲染的消费者，不改变 primitive 默认值和行为。

`leaves36-39-acceptance.html` 保留 **248 对正式截图：246 对字节一致、两对 OPEN；
13,210 条标准节点记录全部相同**。文件操作为 60／1,332、附件 68／2,512、运行配置
72／7,390、预览 48／1,976。两个原差异分别为模型搜索 popup 边缘八 raw 像素，以及
未迁夹具控件边缘 226 raw／三个 threshold 像素。另 51 对 Browser Preview 补充中七对
保留共 57 raw／零 threshold 像素。二十对选定正常动效／局部变量补充截图一致。
新有界截图和相同 CSS 不关闭原像素差异。

预览首轮元素局部采集将 633px 高的 After 与 1,000px Before 混用，这些图明确拒绝为
采集尺寸不匹配。随后四对跨采集方法图片在样式采样一致时仍不同，单列诊断证据。
两侧改用相同真实 Chromium、viewport／PNG 尺寸门禁和实际动画时间线后四对一致。
原流程有界探针记录完整普通／伪元素样式、祖先、命中链、指针／焦点及动画，不写 CSS；
新 PNG 与原 Before 相同，但原始栅格差异原因仍未证明。

既有 51-story 浏览器回归还发现四个生产 Storybook `React.act` 失败。只修 Story 的
原生输入／提交流程以及测试的配置 base URL；修正后的 Before／After 两次都通过。
原失败及截图保留。续批期间临时验证目录消失，已存 manifest／PNG 幸存；按官方 SHA
恢复合规 Node，以本地已提交 UI 和锁定输入重建隔离构建。未同步 main、修 runtime／
后台或 reset 用户工作。

随后的分享页单标题续批移除九处自有 native 布局 utility，保留字重 writer，并显式合并
既有 active-tab 样式。28 对真实 PNG 及 4,102 条标准节点记录相同；十二 CSS 场景比较
24 个 pill／label 节点的 112,728 个普通／伪元素值，包括局部 40px 高／13px 圆角和真实
长标题 ellipsis。边框仍读取现有全局 `--tw-border-style` 注册，移除 Tailwind 全局基础设施
需另验合同。范围检查包括二十项分享测试通过，lint 为十三 warnings／零错误；此成功子集
不关闭任何先前 OPEN。
随后冻结源码回归通过 components 620 文件／6,207 测试和 UI 25 文件／302 测试；
1,264 个产品／样式文件在启动测试前记录哈希，结束全部未变。独立准备的下批 Story
不属于该产品冻结集合。这是 UI 套件证据，不是根检查或 Electron 通过。

尺寸与默认图标续批再移除十二处 utility：Banner／Fork／Share 图标六处、移动账户控件
四处、加密工作区标记默认样式两处。字体保留原 size／leading 变量读取；body 子树内分享
图标保留真实 16×17.5px flex 收缩，不强制正方形。两个账户输入原本就使用 primitive 的
100% 宽，pending Spinner margin 保持局部 spacing。加密标记继续保留 nullish fallback：
空串或 opaque caller class 完整替代默认样式；SVG size14 属性及实际 Menu／Sheet 祖先不变。

`leaves41-acceptance.html` 记录 60 对 PNG 字节一致、1,900 条标准记录相同。每侧引用
原先健康的 52 帧和明确来源的八帧缺失补采，不称单次 clean capture。两侧各四个子树门禁
超时、原 candidate 图片及错误正方形门禁保留为诊断。十八 CSS 场景比较 66 个采样／
310,275 值；十二个新私有 width／height 变量和预期属性改变另记。Banner 首次超时的精确
触发仍未知，留有可执行有界跟进方案，不断言 clock 因果。

42–43 续批另有 64 对 PNG／4,536 条标准记录一致。八对真实正常动效关闭截图把实际
有限退出动画停在起点、推进中的 Spinner 时间线停在 400ms，不证明完整退出动画。
标记比较十二 CSS 场景／36 个 glyph／169,302 值，包括实际 caller 替代和 body 调色板。
范围检查通过，三批归属测试分别为 19／两项／八项；lint 为一／十二／零 warnings，
全部零错误。原 profile 误用和标签大小写校准失败单列，不以最终匹配矩阵关闭历史 OPEN。

Modal 间距／头像图标续批再移除八处 utility。Dialog 与 AlertDialog 共用显式 padding／gap
选择，替代调用方与面板样式争夺优先级；默认值、移除属性复原及内联 style 回调合同保留，
API 由归属 [UI README](../../../../packages/ui/README.md)说明。Drawer 的逻辑 safe-area
内边距和 Base UI 状态回调需独立验收，本批不扩入。两个头像 fallback SVG 在既有五级
图标槽内使用本地 100% 宽高，根 API 和挂载节点不变。UserAvatar 的 Before 是实际工作树
中的 d22e 源码，保留原参数格式 hunk，不以格式不同的 HEAD 副本替代。

`leaves44-45-acceptance.html` 内嵌 108 对字节一致的正式截图、7,536 条相同标准节点记录：
Modal API／消费者为 84／2,520，头像图标为 24／5,016。十二 Modal CSS 场景比较
48 个节点／231,048 值；四个头像 CSS 场景比较 120 节点／563,580 值，预期 class 属性
变化另记。头像 DPR3 探针仅为 CSS 证据，正式截图使用 DPR1／reduced motion。四张真实
Gallery 和四张真实 Electron 图均为 After-only，不混入正式对数。Electron 重建
main／preload／renderer 并复用未改的 bundled CLI；配置页等待状态、应用自带 Explore
演示和空本地聊天不证明 agent／云端流程或桌面前后等价。

首次 Rename 消费者采集已满足真实 popup 条件，但 Dialog 全部 portal 到空 decorator
外，触发了工具要求 story root 可见的门禁。仅这两个 target 使用既有空根例外，仍严格
验证实际 popup 的绘制、间距、主题、焦点和动画。五张原始错误图、两张中断前成功图及
数量修正 addendum 保留，不覆盖原数据。Modal 夹具在前后只将局部旧类 adapter 改为
API 属性，两份原字节哈希均记录。UI 全套通过 25 文件／304 测试；随后冻结源码的
components 全套通过 620 文件／6,207 测试，1,264 个产品／样式文件哈希全部未变。
根格式化通过；实际重跑的根检查仍停在既有 ACP SDK export 构建失败。更早像素 OPEN
和负控合同不改变状态。

Dialog 消费者／Spinner 间距续批在七个产品文件中移除十处 utility：粘贴文本编辑和
Quick Open 使用 modal 间距 API，Operation 回复移除两处 primitive 已声明的布局；
五处私有 Spinner 外边距保留物理 `margin-right` 和元素局部 spacing。
`leaves46-47-acceptance.html` 记录 128 对正式截图字节一致、7,484 条标准记录相同。
粘贴文本前后均用同一 runner 的真实坐标点击，穿过不接收指针的 mirror 命中 textarea；
Spinner 矩阵独立保留此前冻结的 runner。

正常动效补充八对一致、两对 Billing 为 OPEN：137／123 原始像素、18／20 个像素超过
RGB 差值和阈值。目标 470,114 个 CSS／伪元素值、几何及 400ms 动画记录相同，但原始
背景绘制相位未被证明。四个原整页 RTL 弹窗越界失败及动画目标误选校准保留；八个局部
pending 按钮 RTL 状态只证明物理外边距，不证明整页定位。强制 UI-dark／全局 light
夹具的段落在两份源码中均为 rgb(30,30,30)、面板为 rgb(22,22,22)，继承别名链未独立
解析；不以调色板补丁或完整主题整合声明掩盖限制。两组归属测试通过 13／14 项、类型与
格式检查；lint 各保留 17／38 warnings、零错误。更早全套测试保持原源码边界，历史 OPEN
不因本批成功关闭。

输入框高度／CommandDialog 续批再移除九处 utility。`Input` 与 `PasswordInput` 新增
`controlHeight` 表示 well 高度，既有原生 `height` 属性仍传到 input；命名密度和
leading／reveal 槽尺寸不变。普通输入先合并动态 StyleX 变量再应用原 style 对象／状态
回调，带外壳的控件仍把原回调放在内部 input。实际验证零值、移除复原、挂载 ref／焦点／
值保留和密码显隐；归属 UI README 说明 API，不新增 Token 组。

`leaves48-49-acceptance.html` 记录 96 对正式截图、5,296 条相同标准记录：93 对 PNG
一致，三个 Input 显示密码状态各保留一个绿色通道差一的像素，确切栅格原因未证；唯一
未改 Before 控制匹配原 Before 而非 After。28 份 CSS snapshot 比较 296 条选定记录及
425,352 个普通／伪元素值，均无差异；84 个预期新增私有高度变量值和 90 处属性变化单列。
四张真实 Gallery 图为 After-only。UI 全套通过 25 文件／307 测试；冻结源码的
components 全套通过 620／6,207，1,264 个产品／样式文件哈希全部未变。

CommandDialog 的 40 对截图保留 390px 视口中原有的 512px 面板溢出。两张原手机错误图及
八个原未执行状态继续保留；最终来源清单明确组合 30 个健康原采集和十个真实已知溢出
采集，不伪造浏览器 capture manifest。相同结果不表示视口适配、原生／后端执行或历史
OPEN 已关闭；实现与视觉限制分开记录。

私有间距／输入框／Loading 续批在十一个产品文件中移除十七处 utility。三处输入框高度与
删除工作区、Emoji、公开浏览器 Spinner 尺寸使用既有 primitive API；九处私有外边距／偏移
保留局部 spacing，实际完整构建确认长属性优先级，保留 absolute 和未知 Skeleton class
标记，不把未知源标记视为冗余 shrink utility。Emoji runner 暂停真实 bundled 请求后继续
原响应，Loading、加载后搜索／键盘／滚动／forced-colors 均为真实界面。

`leaves50-54-acceptance.html` 内含 208 对正式截图、12,304 条相同完整布局记录：204 对
PNG 一致，四对原始 OPEN 保留；来源方法明确为 180 对标准采集和 28 对 native。折叠
PlanBar 为 14 原始像素／零超阈值，三张删除面板图为 28 原始／四超阈值；有界控制和相同
CSS／几何不证明原始栅格触发。四对真实正常动效 renderer Spinner 图单列且一致。选定
CSS 探针保留预期私有变量与原始属性变化，不把初次未稳定的 Emoji 颜色值归一化或替代
正式截图。

公开浏览器夹具只验收 renderer 的 Loading／ready／error 和明确 never-forward 的
synthetic IPC 应答。首批 32 张候选图被拒：正常动效探针暴露两个未处理的主题 setter IPC
真实错误。只修夹具并重建原产品源码后，重新建立干净的 Before32／normal4；原错误／图及
首批 32 张候选继续保留，不声称 WebContentsView 内容、原生导航或网络执行。五组归属
检查保留其范围，全套 components／UI 测试仍归于 49 边界。报告包含八个原间距门禁失败，
其中四个 Banner 触发仍 UNKNOWN；新成功范围不关闭这些及更早 OPEN。

私有 Header、dark 选项与置顶消息续批在六个产品文件中移除十八处 utility。
既有 primitive API 继续负责控件尺寸，局部 StyleX 负责私有外边距、偏移和用量分享 Header。
受保护的 Calendar 源码仅逆转两处任务 hunk 即可精确恢复实际原工作字节；用户已有格式改动
不属于该补丁。

`leaves55-59-acceptance.html` 记录 **164 对完全一致的正式 PNG 和 26,232 条相同完整标准
布局记录**：55 为 44／7,920，56 为 48／4,080，57 为 48／880，59 为 24／13,352。
每行保留原不可变构建、manifest 与哈希；仅计算样式检查不新增截图对数。报告内嵌
143 张唯一真实浏览器 PNG、四张明确标记的派生遮罩、十六对被拒候选和四张原门禁失败图。
旧报告及其 OPEN 均保持冻结。

dark 选项完整保留主题／light 排除条件、白色 alpha fallback／supports 与 hover 媒体条件。
coarse hover 仍是原 foreground 5%，dark 键盘 focus 以局部 `--color-white` 读取 10%；
局部 scope 夹具不强制整个 UIThemeRoot 调色板。SessionPin 保留 `flex-1`／`justify-start`：
完整真实构建中的六类 DOM 原型把 flex-shrink 从 1 变为 0，因此只迁四个不冲突属性；宽度动作
是切换，不总是展开。用量分享 Header 在 639／640px 与 RTL 下保留逻辑 padding-inline、
物理右内边距、局部边框样式 writer，以及编译器实际的**不透明**边框颜色 fallback；
支持 color-mix 时才使用 70%。其他字体与控件兼容类继续保留。

WindowDragStrip58 接受零处 utility。真实 renderer／公开调用方反例表明 absolute／fixed
胜者反转，已测 z-index 用例保持不变，其他几何属性仍未证明；不验证原生 OS 窗口拖动。
后续侧栏60候选也接受零处：真实基础／状态与公开 descendant 调用方改变颜色、透明度和
pointer-events 胜者后，三个源文件均精确恢复。保留的十六对候选中十二对像素一致、四对
不同，独立于164对正式截图；并非将其余属性都归为相同已证失败。这些是该候选的局部反例，
不代表所有公开样式永久阻塞；后续可将完整 owner 与真实调用合同作为同一单元迁移。
不完整 native 候选只有25／28个 checkpoint，超时触发原因未明，不伪造缺失截图。

归属检查通过55的22测试、56的5测试与59的27项相关聚合／导出适配器测试；57没有直接
归属套件，保留真实 callback、键盘／取消置顶／宽度切换与 CSS 证据的边界。类型与明确
格式检查通过，typed lint 分别为32／0／1／2个警告、零错误。完整冻结源码回归归属于
下文截至 63 的边界，不改称精确截至 59 的视觉证明。原59 portal 根节点错误与修正后
严格真实弹窗采集并存。
组件 Header 故事不证明当前生产菜单流程；Calendar 手机底部内容、用量分享手机首屏
预览可见性继续有边界。synthetic 公开数据不证明后端／发布／导出／原生流程、每一动画帧
或真实 iOS 行为。

通知、菜单与自有暗色样式续迁在六个文件中移除八处 utility。通知私有文字复用既有
action theme；四组同元素 Token 负控仍展示真实文字颜色差异。Help 使用既有
`minWidth={160}` API，三处浮层 overflow 与未改动的控件默认声明重复。文件提示文字和
终端选中标签保留完整 dark／light-scope 条件，并在元素处读取变量。

`leaves60-63-acceptance.html` 保留 **134 对正式截图：132 对逐字节一致，两对 OPEN**，
合计 43 个原始差异像素。9,284 条配对标准记录中 9,270 条一致；十四条原始高度变化
已在两侧实际 DOM 定位到空的、不可见 xterm 辅助节点，原记录没有归一化。有界控制不能
证明历史像素差异的精确原因。原六张手机 Role 越界失败图不在验收范围内。通知 Before
明确由 48 张原始健康帧和 16 张修正根调色板的帧组成；被拒校准与不同 harness 来源均
保留。真实滚动补充图、CSS 检查和两张终端 After-only 检查另计，此源码边界仍是部分验收。

完整回归在此边界冻结 1,486 份产品源码：components 620 文件／6,207 测试和共享 UI
25／307 全部通过，所属子集不重复相加。根检查仍保留既有 ACP 前置失败，本次 UI 工作
没有修改 ACP 依赖或后端行为。报告继续保留已撤回的第 60 批候选和所有更早 OPEN。

控件间距续迁在八个产品文件中再移除 22 处 utility。五处 Select 宽度已由 well 提供；
私有归档填充保留不透明 fallback 与支持时的 35% 混色。其他固定控件在元素处直接写既有
公开 Button Token；已有主题的 Operation action 在同文件完整主题中合并外观与间距。
规则由 [`MIGRATION.md`](../../../../packages/components/src/style/MIGRATION.md) 统一说明。

默认截图漏过一次真实跨文件 spread 回归：48 对图全部一致，父级 gap 却从 9px 变为
6px、圆角从 9px 变为 8px，并改变字体和颜色。真实父主题图有 3,317 个原始差异像素，
修后与 Before 逐字节一致。另一被拒候选有 180 项非预期 CSS 差异。修后非目标 Token
一致。私有 Button 夹具已改为编译器本地完整 map：20 对受影响真实图和 724 条记录仍相同，
两个实际 CSSOM 主题均有 27 项声明，包括 18 项继承。此夹具修正不计产品 utility 迁移。
两个较早的 message-action 夹具 helper 仍待该审计，实测显式覆盖不证明遗漏的继承声明已生成。

`leaves64-67-acceptance.html` 保留 **192 对正式图中 191 对逐字节一致、48,356 条完整标准
记录相同**。Select 原边角仍 OPEN（11 原始／6 阈值像素）；另一次 native 样本中一个
Button 和三个子节点 y−4px，原样本没有 PNG，后继完整 Dialog 控制相同也不证明原始原因。
八组同元素 inline Token 负控保留实际布局变化，独立于已闭合产品输入。十二张原始错误图、
修正门禁后的明确来源组合及所有更早 OPEN 均保留。另一次截至 71 的工作区回归通过
components 620 文件／6,207 测试及 UI 25／307，运行期间 1,861 份 UI 源文件哈希不变。
真实 OSS Electron 构建及四页冒烟通过，截图仅属 After，没有应用 Before 基线。
这些检查不证明原生图标、导出或后端流程；冻结报告仍各自保留源码边界。

弹窗与浮层续迁在八个产品文件移除十八处 utility。固定标题、页脚和 popup 几何局部写入已有
公开 Token，三个标准模块导出不增加 Token 组或依赖。DrawerContent 通过显式 `width="full"`
让真实文件查看器调用方移除两个 important 宽度类；省略属性保留原方向类与 style 合同。
另五个全屏调用点不计已迁移。Token 覆盖仍须按归属指南审计所有后代读取者。

`leaves68-71-acceptance.html` 将 **208 对产品图／200 对逐字节一致／10,248 条完整标准
记录相同**与二十对相同的夹具修正图分开。八对原触发器边角仍 OPEN（48 原始像素、零阈值
像素）。Drawer 两对原正常动效也仍 OPEN（25,902 原始／11,176 阈值像素）。后继协议的三张
实际合成器位置错误，虽然主线程动画记录相同；真实像素边界和同页 WAAPI 顺序控制证明其为
采样失败。这些采集不接受，后继匹配控制也不关闭前两对未知差异。已知 inline Token 负控、
校准错误和真实 Electron After-only 图均另列。

字体和命令面板续迁在六个文件移除十二处 utility。标题、描述保留原元素局部 `--text-*`
字号与 `--tw-leading` fallback 表达式，字重和显式 leading writer 均不变。闭合的 Command
backdrop 保留 `#0006` fallback、特性分支内的局部黑色 mix 以及完整九项 filter 管线。
面板继续保留 `bg-transparent`：发布背景 Token 确实改变了实际子元素继承值，对公开任意
ReactNode children 并不安全，即使默认面板像素相同。两份被拒源码均保留。

`leaves72-73-acceptance.html` 保留 **112 对图／111 对逐字节一致／9,748 条完整标准记录
相同**。原背景按钮模糊区域仍有 429 原始像素、零阈值像素差异；独立 Canvas 和 PNG 解码
结果相同。有界原流程控制与 After 相同，也不能解释原始原因。旧工具 `identical` 使用阈值和
布局判断，最初四十对候选实际仅三十九对 PNG 字节一致；原标签与明确更正均保留。局部字号
正控、已知 inline 负控、真实 portal 门禁失败与所有更早 OPEN 均保留。

### 控件归属与采集边界

第 74–95 批通过既有 primitive 迁移 Tooltip、resize edge、标签、上下文与实心操作样式，
保留实际调用方合同，不新增 Token 组或依赖。Button 新增 CSS 类型的 `fontSize`、
`lineHeight` 与平实 `solid` variant，ResizableHandle 新增显式 edge 外观；原默认不变。

接受完整 CSS 值的字体 API 必须写实际 CSS 字段。被拒的 custom-property 实现虽通过
六十对普通截图，却改变 `initial`、`inherit`、`revert` 和嵌套 `var()` fallback 语义。
最终字段与归属层 StyleX inline 值合并，两项省略时保留原 style 对象，通过 104 个浏览器
语义用例与 24 个 class 优先级用例；直接 caller style 和 Base UI render 元素合并另列。
固定文本 Field 标签则写既有字号／leading Token：输入为兄弟节点，标签无后代读取者。
Login 保留完整字号／leading，移动标签仅改字号；字重、tracking、私有 leading writer 保留。

固定 Card 标题也写既有字号／leading Token，保留字重与 tracking。Textarea 使用既有
resize／min-height／background 合同及已有 `style` 的实际字号／leading 字段，保留
placeholder、受控值、pending 和取消行为，没有新增通用样式逃生 API。

Skeleton 新增显式 `ring` 形状，中心透明、默认描边 2px。`strokeWidth` 仅影响该形状，
显式零有效，移除后恢复默认描边；其他形状的尺寸和绘制不变。固定日历环通过已有 feedback
Token 保留原元素局部 primary 表达式；不支持 color-mix 时的 fallback 是不透明
`hsl(var(--primary))`，不能猜成 10% HSL alpha。当前环没有 children，继承 Token 覆盖
不构成任意后代合同。正常 pulse 端点及已有默认／零／移除尺寸控制均分别真实渲染，未增加
Token 组。

固定 Avatar 调用保留 medium 上下文，只覆盖已有尺寸 Token；改命名 rung 会同时改变
Fallback 字母、图标和圆角。应用自有移动 `xs` 保留局部 `spacing * 5`、字面 `.68rem`
字号与 `.25rem` 圆角，行高继续继承。受保护 UserAvatar 源码未改。十组同元素尺寸 Token
控制证明迁移后的优先级边界变化，作为明确负控保留；已审私有调用不暴露该 writer。

无障碍名称继续挂载：显式 `visuallyHidden` 在实际 Dialog／Vaul Title／Description 及
Popover Title 的归属层组合编译器原九字段，不更换上下文、DOM 或 ARIA 属性。
1px／-1px、`inset(50%)` 是固定物理值，不随主题 spacing。Dialog Title 在同次归属层组合
清除原 logical-end padding；默认 parts 的旧字段、ID、ref、render 元素合并不变。
共享 Dialog／AlertDialog／Base UI Drawer 的 Header 也支持同一显式选项，
隐藏整个名称块；Footer 不支持。Sidebar 调用仅改该属性，原用户 diff 字节不变。
Gallery 图仅为 After。Stack 原 dangling `aria-describedby` 两侧同样缺失，不能称所有
ARIA 均有效。

`solid` 仅拥有填充、文字、精细 hover 90% alpha 与已有 focus ring，读取既有 primary 颜色，
如 primary 一样忽略 destructive tone，不引入 sheen、edge 或按压 transform。私有 Session
主题继承其余二十五个 Button Token，六个旧 shadow／transition／active utility 及原焦点结果
保留。165 个旧 variant 对照节点的原始属性、完整普通／伪元素／变量样式与几何相同。
Token 写入只用于已审查固定 glyph／文本子树，真实同元素 inline Token 负控不接受为任意
输入等价。

Resize edge 在归属层组合 base，不与调用方 class 竞争。实际调用是水平方向，默认竖向
覆盖不证明新 edge 外观。正常动效环境验证真实 150ms delay／duration 与禁用截图动画后的
稳定端点，不声称完整连续序列。私有 diff-notice／DiffViewer Header 保留 dark 边框 utility：
真实公开 `*:` 调用方暴露迁层无法保留的排序合同。其余 Header 与原生 Chevron 样式迁移，
保留原非正方形收缩；完整构建 CSSOM 验证逻辑 inset，不能把 margin-block 编译问题泛化为
所有 camelCase 逻辑属性。

保留实际编译与局部变量合同：Tooltip `max-w-xs` 是字面 `20rem`，其他固定上限为
420px／22rem，spacing 上限仍读局部变量。Context 的 `px-*` 与 UI 归属层都编译为
`padding-inline`，四对竖排 PNG 验证四个非零物理边。移动菜单 row 没有归属层 font-size
声明，详情保留全局 monospace 变量与连字 hook。两处 composer resize 在实际
CombinedMentionTextarea 两路径均冗余，不承诺导出 helper 可为任意裸 textarea 提供该行为。

焦点提示保留全部 `.group` 祖先，包括 composer 外层。完整编译将 StyleX class 加倍，最终
`:where(.group:focus-within *)` 保留总 specificity 二；人工同元素 `opacity-100` 仍因迁层
改变胜负。私有提示没有 caller class/style 槽，未用额外 specificity 掩盖。Tabs 手动激活：
方向键移动焦点，Enter 选择。十二个原失败断言与十二个严格修正 cell 并列；十六个 Login
`email-focused` 键实际最后填写密码，报告更正为填好凭据／密码聚焦，原键保留。

小型 provider／memory-router 场景挂实际 MobileWorkspaceStack、ChatLanding 与真实
SessionDetail loading 分支，没有替换子组件或 runtime。已有全宽 API 移除归属层自己的
方向上限，只验收这一调用点，四个 SessionDetail 内部 Drawer 仍未访问。私有 inline 宽度
注入的已知负控不属于 Stack props。原 native Escape 超时与可信 content 按键控制、明确
补缺来源并列，缺失原 DOM 时不追认原超时原因。

| 冻结报告                      | 正式对数／字节相同／完整标准记录 | 保留原 OPEN，原始／阈值像素                            |
| ----------------------------- | -------------------------------: | ------------------------------------------------------ |
| `leaves74-78-acceptance.html` |                 310／305／30,303 | 正式五对 13／0；侧栏补充两对 882／829。                |
| `leaves79-81-acceptance.html` |                 296／292／14,056 | 正式四对 1,075／0；native 补充一对 22／0。             |
| `leaves82-84-acceptance.html` |                 306／305／12,854 | disabled Button 边角一对 10／7。                       |
| `leaves85-88-acceptance.html` |                 284／284／12,554 | 无新增正式 OPEN；所有历史 OPEN 保留。                  |
| `leaves90-93-acceptance.html` |                  164／164／8,068 | 原 hover 三对 5,602／5,534；native 页头一对 473／402。 |
| `leaves94-95-acceptance.html` |                 152／152／27,218 | 无新增正式 OPEN；十组已知尺寸 Token 负控单列。         |
| `leaves97-acceptance.html`    |                    64／60／5,704 | 原页头四对 OPEN：78 原始／2 阈值像素。                 |
| `leaves99-acceptance.html`    |                  110／109／2,848 | 原 pending 一对 OPEN：5,932 原始／0 阈值像素。         |

85–88 组包含三十六对实际 Stack 与二十四对单列既有 API 控制，控制不增加 utility 计数。
后继匹配控制不关闭原未知栅格差异。实际主题门禁拒绝 light URL 错标的固定 dark 场景；
Archive hover 与 Monaco tokenizer 失败有有界同源证据、明确修正 cell，原数据全部保留。
被拒字体候选、没有伪造 After 图的 selector 源码、inline 负控、Gallery After-only 图及更早
OPEN 分开保留。

标签 native 验证明确先聚焦输入。原 rest 流程观测到 `scrollLeft=804` 使标签出视口，真实
focus 使其归零，没有赋值滚动位置或改产品 CSS。十八对可见 focused 图相同，六对 Token
负控不同，原视口外／几何失败仍拒绝。两个 native 进程记录二十四行后，在末 checkpoint
后停滞且已无 Chrome 子进程，已仅终止自己的 Node；原 `complete:false` 保留，末
label-click／cleanup 仍 UNKNOWN，不称正常关闭或末行为通过。

90–93 通过局部 Spinner 颜色、固定文本菜单 caption Token 与 Header 选项移除八处源码
utility。两个真实移动文件查看器 Button 使用已有 width／height API，保留边缘 margin。
六个迁移的运行时 utility 应用不删除 helper 字面量；两个已有 margin 参数变得可静态识别，
因此统计净减六。菜单保留 `font-normal`：被拒私有字重 writer 被编到 CSS 层外，使真实
`font-semibold` 控制从 600 变为 400，没有提高 specificity 掩盖。Integration Spinner
原样保留：本地 identity snapshot 使真实 pending 分支无法挂载。

明确的视口外指针／hover 门禁通过最终文件查看器矩阵，但原三对 hover 差异仍 OPEN。
未改 Before 在 fresh context 之间也变化，不证明 Chromium 的精确触发原因。另有一对
native 项目页头差异位于迁移 Spinner 外，目标 CSS 相同及同源栅格控制不能关闭它。
被拒字重图、Token 负控和失败采集继续分列。

截至 93 的完整工作区回归冻结 1,867 份 UI 源码、146 份 Electron 源码、五份元数据与
733 份测试源码，期间哈希不变。components 620 文件／6,208 测试、UI 25／312、真实
Electron 构建／四页冒烟通过，主 Agent 已看四张应用图。它们仅为 After，未配置 agent
的 local chat 不证明真实 agent send/stop 调度。Table 的七十八条既有 Styleq warning
与截至 84 相同；更早全量回归保留准确边界，无关根 ACP 前置失败仍阻止将根检查称为通过。

主组件续迁通过已有 Vaul Content 的显式选项迁移两处固定安全区底部 padding，保留局部
`max(1.25rem, var(--safe-area-bottom, 0px))` 的 rem／安全区输入；默认方向样式、键盘位置、
焦点和 portal 归属不变。最小真实 Add-project story 补上旧夹具缺失的 callbacks。注入
`pb-0` 的控制暴露迁层后的胜负变化，继续作为固定私有调用的负控，不承诺任意公开 caller
的优先级均等价。

Rename 固定 Textarea 使用已有 resize／min-height／padding 合同及布局 overflow style。
ref 继续拥有 height，并切换 hidden／auto；长值保存／失败且 draft 不变的真实重渲染验证
新属性不会重置该 writer。leading 和组合 shadow／ring utility 保留。原 320px Dialog
裁切单列，没有借迁移重新设计。原 pending 帧 5,932 个原始差异像素仍 OPEN，即使各 RGB
通道仅差一级、阈值像素为零。canonical launcher 与 system Chrome 控制保持不同 engine
边界，不能据此证明原栅格触发原因。

截至 95 的共享 UI 独立全量回归另通过 25 文件／313 测试，111 份源码／测试／manifest
哈希不变，七十八条既有 Styleq warning 相同。这不扩展截至 93 的 Electron 边界。随后截至
99 的 components 独立全量回归通过 620 文件／6,209 测试，2,539 份记录的源码、测试与
元数据哈希始终不变。该运行包含工作区既有用户修改，不代表再次运行 Electron、helper
或根检查。

### 独立 Review Renderer 样式宿主

helper 在 Vite、Storybook、独立 HTML 和 Vitest 之间共享自己的 StyleX 0.19 编译配置，
保留既有元素局部 CSS 变量与层顺序。Findings 和引用 chip 移除五十九处源码 utility，
私有 writer 与局部控件兼容类保留；不导入产品 primitive 或调色板组。lock 只增加 helper
的两个 importer 条目和五个必需 peer-context snapshot，原有解析结果全部不变。

真实 `file://` 验证发现构建成功仍会丢失编译样式：提取早于 Vite 输出 CSS，随后兜底在
单文件内联之后写出无人引用的 sidecar。最终配置保留 pre 源码变换，将同一个 plugin 的
输出 hook 移至 inliner 之前。[独立构建归属文档](../../../../packages/code-review-helper/standalone-build.md#style-extraction-and-single-file-output)
说明该顺序。修复后八对独立 HTML 的 PNG 和完整记录相同。原错误 HTML、十二张图与八对
被拒比较仍保留；截图裁切相同但视口外记录不同的结果没有被验收。

`leaves96-98-acceptance.html` 包含一百二十八对正式帧，其中一百二十五对 PNG 字节相同，
66,536 条完整标准记录相同。包含四对 native 补充帧在内的七个原栅格差异仍 OPEN，共
187 原始／零阈值像素；有限同源控制不证明原因。已有 helper 测试通过五文件／三十三例，
公开边界检查通过。这些结果仅覆盖固定 Vesper 主题与已审查状态，不扩展到未访问的
helper 区域或整个 monorepo，主组件库存不扣除本宿主的移除数量。独立截至 100 的 helper
快照按成功构建哈希核对三十二份生产 JS／TS 文件，排除 stories／测试，使用同一 v2 AST
规则但以 helper 真实 CSS 入口验证候选。其下界为十个文件／1,151 处／二十六个未解析
表达式，其中 ReviewRenderer 保留八百九十一处；该宿主不与主产品时间线混算。

严重性标记续迁将二十处颜色 utility 收入一个局部 map，读取 helper 真实 warning／danger
变量，保留精确 alpha／fallback 和细指针 hover 条件。两个 reader 仍为私有 finding badge
与 light-DOM inline marker，不替换第三方 shadow 实现。真实夹具覆盖五种 badge 颜色及
三种有效 inline marker 严重性。`leaves100-acceptance.html` 记录八十对正式帧／44,560 条
标准记录和六对相同的单文件结果。
四个原 native 差异即使完整记录字段相同仍 OPEN，共 130 原始／零阈值像素。一次有界完整
面板控制、两对正常动效与两对粗指针控制也相同，均不证明原栅格原因或扩大固定主题边界。

分组／Alert 续迁再移除七十六处 utility：私有分组区域四十九处、局部 Alert owner 二十七处。
页头 ref、ResizeObserver、sticky offset 与回调不变，窄页原来不固定的行为也保留。
编号继续使用 `calc(infinity * 1px)`，统计数字保持真实完整 monospace 栈，六个私有 writer
或复合规则保留。一次误用 camelCase CSSOM 查询产生空 font-family 候选，两个构建均在
任何有效 After 图产生前失败；修正候选读取真实编译声明。

Alert 保留 CVA 选择既有变体，只将各值映射为静态 StyleX 类，不重写 default／null 语义。
六个 SVG／条件 grid utility 与三个 Title writer 保留。七个透明度声明恢复原不透明 HSL
fallback 及对应 color-mix 支持条件；仅在支持该特性的 Chromium 中截图遗漏了这个问题。
修复后四对隔离 fallback 分支的比较相同，四对保留候选存在 564,770 原始／558,438 阈值
像素差异。CSSOM 分支隔离仅为诊断，不代表在原生不支持浏览器上执行。局部明暗调色板
夹具与真实固定 Vesper 宿主分列，原十二张误标 dark 的浅色帧不计暗主题覆盖。

`leaves101-102-acceptance.html` 记录九十二对正式帧，其中七十六对 PNG 字节相同，24,255
条标准记录相同。十六对正式差异共七十五原始像素，五对 native 差异另有二十二原始像素，
阈值像素均为零，全部仍 OPEN。首轮六十六帧分组矩阵另保留十对完整记录不等、九对 PNG
不等；一次完整预热后的严格矩阵六十六对完整记录相同，不能据此关闭旧证据。native 共
验证 1,486 条完整节点记录。分组没有执行独立 HTML 的 Before／After，两个真实单文件
After-only 图明确仅作冒烟。合组报告已通过真实桌面／手机浏览器验收。

同一独立 helper 库存在这两单元后为十文件／1,075 处／二十六个未解析表达式，三十二份
生产 JS／TS 文件均按最终成功构建哈希核对。较 1,151 减少七十六处，不包含 stories、
测试、后续正在迁移的代码，也不与主组件时间线混算。

### 私有评论与局部控件兼容路径

评论／finding 续迁将 114 处私有 Renderer utility 迁入 StyleX。103 批保留字面量 `font-sans`：
被拒绝的 115 处候选即使 112 对 PNG 相同仍改变字体回退列表，三十五对记录不等的候选
继续标为拒绝。后续版本匹配探针定位到 unplugin 的 Lightning CSS1.33 后处理：默认
Browserslist 包含 Android144，触发 system-ui 兼容扩栈；Tailwind4.3 固定目标不含 Android。
[版本化字体实现](https://raw.githubusercontent.com/parcel-bundler/lightningcss/v1.33.0/src/properties/font.rs)
与独立分阶段／分目标控制一致。同 textarea 上的固定私有变量候选保留原 literal，不读根
字体别名、不加 fallback 或改全局目标；隔离副本两次完整构建与十四对真实正向帧相同，
两对直接写新私有名的负控仍为差异。112 批已实施同元素私有变量，二十二对正向字体、
placeholder、旧变量和交互帧，加两对完整 Renderer 帧，既有字段与 PNG 均相同；新私有
声明另验。生成的 StyleX 层名递增一位，但两个宿主各七百一十条公共规则的选择器、声明、
条件与相对顺序不变，没有手写引用绑定这些生成名。不宣称任意 DOM 注入等价，也不关闭
原 115 候选差异。`leaves103-105-acceptance.html` 包含 156 对正式帧，其中 153 对 PNG 字节
相同、73,555 条标准记录相同；三对正式 OPEN 共十七原始／零阈值像素，一对 native OPEN
另有十七原始／一阈值像素。实际导航、composer 缩放、键盘保存与八对离线文件已覆盖，
原截图工具 caret 和就绪失败仍单列保留。

删除两个无人使用的内部 Card／Badge 模块另减少五十四处出现次数，迁移计数为零。
完成解析的 AST 导入／导出图未发现受支持入口或运行时使用者；独立 HTML JavaScript
字节相同，CSS 仅删除二十五个选择器上下文／1,929 字节。清理两侧环境使用相同的旧控件
候选，只证明这次删除差量。

局部 Dropdown／Tooltip 与 Button／ToggleGroup 保持两个明确路径：普通元素使用 StyleX，
合法 `asChild` 子元素保留原 utility 级联。导出类选择器在 285 个输入下保持原始字符串和
顺序，每个模块以一个 CVA 声明提供两个选择器，不增加运行时类解析或公开样式引擎选项。
源码移除为零，35+51=86 处普通运行路径映射另计。将 Slot 默认值移到更早的 StyleX 层
曾真实反转子元素优先级，首次修复又遗漏三个转发标志；两个失败候选分别保留 55,508 和
31,564 原始差异像素。最终完整转发五个标志，恢复标签、焦点、几何与级联，无特异性补丁。

`leaves104-106-acceptance.html` 包含 194 对当前 PNG 字节相同且完整记录相同的结果：
九十八对正式帧／1,476 条标准记录、八十四对 native／Slot、八对实际 Renderer toolbar
和四对离线文件。此前十四对成功帧属于历史源码。实际手机 CommitRow Tooltip 两侧都未
通过绘制就绪门，仍为 NOT_ACCEPTED，专用夹具和桌面成功不能关闭此调用点缺口。两份新
报告通过真实 1280／390 浏览器验收，全部历史 OPEN 保留。主 Agent 独立重读原始 PNG／
完整记录并查看最终报告；helper 结果不提升根全检查、Electron 或主组件覆盖边界。

文件树／commit 续迁再将 182 处私有 utility 迁入局部样式，保留原生 checked／
indeterminate、文件名截断、RTL 物理属性、commit 详情、剪贴板写入／读回及局部 white
变量合同。最后一个 `text-white` 字面量消失后，完整 Storybook 与独立 HTML CSS 仍有
原 white writer／reader；没有增加 alias 或 fallback，也不推断编译器保留机制。
不可达 EmptyThread 分支另减少二十七处，迁移计数为零：私有 guard 恰为唯一调用者面板
挂载条件的布尔补集，实际空态／保存／取消／删除路径保持原行为。

冻结 107 矩阵包含 136 对正式帧，其中 108 对 PNG 字节相同、66,456 条记录相同。
二十八对正式 OPEN 保留 7,795 原始／7,536 参考阈值像素，一对正常动效另有一个原始像素。
三十对 native／2,694 条完整记录与十对真实离线文件相同。手机 missing-record Tooltip
两侧同样位于视口外，不算 Tooltip 已绘制覆盖。原两对 reviewed 状态未验收：
aria-expanded 改变后 forceExpanded 仍让 body 挂载两秒，替代帧等待实际 body 消失，
不写入状态。有界 Viewed 控制记录复选框属性、七个伪态、焦点、完整 CSS 与精确几何，
重复 Before 帧呈现原 After 栅格。另一次主 Agent 的 1024 控制记录全部页头后代，两侧
均重现原 Before PNG；三张 PNG 相同，Before／After 的 pre 对象、post 对象分别相同。
两项有界控制都单列截图工具
将 style 从 null 序列化为空串的影响。原帧没有这些标志，不能推定瞬时绘制原因或关闭
任何原 OPEN。

截至 107 的纯生产源码快照逐一符合三十份成功构建输入哈希，以同一 v2 AST 和 helper
真实 CSS 验证，得 **698 处／八个使用文件／十八个未解析表达式**，其中 ReviewRenderer
为 519 处。1,075→698 的减少分列 296 处迁移和八十一处闲置／不可达清理；八十六处控件
运行路径映射没有移除源码字面量。stories、测试、后续工作与主组件 1,424 库存保持独立。

Separator 续迁将相同的普通／Slot 分流用于六处普通运行路径映射，源码移除为零。
既有 JavaScript orientation 分支仍决定样式，不由原始或 Radix 规范化 data 属性替代。
ref、语义／装饰角色、嵌套 children、inline／caller 优先级，甚至原非法 orientation 的
样式／属性不一致都保留。三十六对 PNG／完整记录相同，其中四对实际 Sidebar 裁切来自
Storybook 与离线文件。原四张局部颜色帧因复用稳定计数器，在极短真实 transition 结束前
误接受旧颜色而拒绝；逐状态清零并等待动画结束及目标 RGBA 修正采集协议，无产品补丁。
完整页面图仅为 After-only，不宣称手机 Sidebar 已绘制覆盖。

diff／context 续迁移除七十八处私有 utility，render 前行为逻辑逐字不变。两个 Button
SVG size sentinel、primitive caller 与私有 font／ring／leading writer 保留。
未分层 `.crh-block` 背景仍压过 `bg-card`，没有在无效 StyleX 后藏原 utility 或虚计迁移。
最小真实 parser 夹具覆盖九行 context、四行选区、长行与 missing-resolved-file Alert；
不代表 parse-error 覆盖，后者原样式保留。

一百二十对正式帧中七十六对 PNG 相同、39,822 条标准记录相同；四十四对正式 OPEN 共
207 原始／九阈值像素，两对 native OPEN 另有 140 原始／126 阈值像素，1,029 条完整
native 记录均相同。八对正常动效／304 条完整记录与十对离线文件／454 条记录及 1,850 条
几何记录相同。native After 和离线最终关闭没有返回，保存完整 checkpoint 后仅停止自有
Node 进程，两者继续标记 `closedNormally=false`，帧相同不代表清理成功。主 Agent 独立
核对两单元共 204 对全部原始记录、PNG SHA 与解码像素，并实际观察桌面／手机的 context
和 composer；全部历史 OPEN 状态保留。

私有 shell／导航 111 批移除 163 处 utility，ref、observer、callback 和 inline 列几何不变。
一百三十三对正式帧保留 44,522 条相同标准记录，其中 118 对 PNG 相同；native 二十对和
离线二十对相同。一对正常动效与十五对正式 OPEN 共 119 原始／24 参考阈值像素，这十六
对继续未关闭；原 native 最终关闭仍为 UNKNOWN。112 批字体证据按上述正向／负控合同
单列。

Markdown／诊断 115 批移除二十七处：v2 识别二十二处，另五处位于固定 codeClassName
默认参数，v2 漏计。删除最后两个 space-y 后，原 reverse 属性注册与 fallback 也被裁掉；
该候选继续拒绝，六对完整记录均不等，四对 PNG 共差 326,910 原始／312,705 阈值像素。
最终样式表保留原 properties 层注册和兼容 fallback；未分层 code-block margin 仍由原
规则拥有，不加无效 StyleX margin 替代。当前九十四对完整记录相同，八十五对 PNG 相同，
九对 OPEN 共 185 原始／零阈值像素；原候选和旧栅格变体单列。主 Agent 独立核对原始
记录、哈希与解码像素。

截至 115 的真实成功构建库存冻结三十份生产源码与最终 helper CSS：**434 处／八个使用
文件／二十一个未解析表达式**，ReviewRenderer 为 255。截至 112 仍为 456／8／18；115
减少二十二处扫描出现次数及五处单列默认参数。新增三个未解析项均为私有 StyleX
blockClassName 引用，没有新增 Tailwind。109 的 620／8／18 保持历史，清理与运行路径
映射不算迁移。该 helper 边界当时的独立主产品库存为截至 110 的 1,424／157／726，
不含后续 helper117／119 与未访问状态。该单独检查不提升主组件／Electron 全套边界，
当前整合验证见下述
产品续迁；根 ACP 前置失败未解除。

### legacy Sidebar 兼容与纠错

公开 legacy Sidebar 保留原有 303 处 utility。空 caller-class 守卫既不能隔离祖先选择器，
也不能保持其 layer 优先级。真实编译器接受的零特异性祖先 utility 原本输给直接 utility，
默认样式移到更早的 StyleX 层后却胜出：Header gap 8→48px、MenuButton 宽度 239→40px、
GroupLabel 高度 32→48px。按钮 used width 受保留 padding 限制，不是存在 40px min-width；
Slot 正确也不能证明普通元素兼容。

127 纠错撤回 110／113／114／116／120 的全部 111 处默认运行路径映射，逐字节恢复真实
Before110；此前 27 批三个内部迁移保留。禁用状态 121 和字号 122 候选均拒绝、计数为零；
前者让本来拦截的 ARIA 鼠标回调实际执行。没有加特异性、编译器／layer、事件或样式引擎
补丁。原 class 字符串、CVA 变体与公共 caller 组合合同保留；后续方案必须保持完整受支持
caller 合同，保留兼容类优于误导的仅默认路径迁移。

原版→恢复版 127 共三十二对 PNG／完整记录相同：八个祖先／默认场景 152 节点，加二十四
个既有 native 场景 600 节点。六个真实祖先反例保留 197,149 原始／195,018 参考阈值像素，
反向纠错图描述同六例，不重复计问题。旧报告不可改写：其有界匹配矩阵不足以证明公开等价，
111 处运行路径信用已撤回，任何历史栅格 OPEN 都未关闭。task-only Git blob 排除用户的
Tooltip 空格，浏览器快照仅该精确字节不同；隔离 Storybook 树二十五份未动用户文件的差异
仍明确保留。

持久浏览器回归132 在既有fixture增加三个实际编译的祖先caller。六个theme／scenario
测试对照真实Default／caller PNG、明确几何及十二条click路径，十二对正向图完全相同；
同一suite在实际CSS门禁、截图与click后，拒绝六个历史unsafe案例。197,133原始／
195,115阈值整图像素及六个不同尺寸crop是负控，不增加迁移信用。它是窄回归canary，
不是完整computed CSS或公开兼容证明；缺少locked browser与installer恢复失败单列保留。

### 闭合消费者控件与整合证据

SessionSearchBar118 通过已有 owner token 迁移十处固定 Input／Tooltip utility。
三十对正式帧／984 条标准记录和二十六对正向 native／690 节点加 3,328 几何记录相同。
节点及三个伪元素的七十三个非目标 token 相同，七个有意变更的目标 token 另计。六个直接
DOM token writer 负控在固定私有调用图之外。原十二处候选拒绝：三十对正式 PNG 相同，
按钮圆角却 6→10px，祖先 stress 下 13→29px；同元素 message-action theme 胜过新 radius
atom。最终保留两个物理 rounded-md，没有新 radius API 或特异性补丁。

ChatLanding124 通过已有 width／height API 迁移导航按钮两个尺寸，使用真实 Electron
local-chat UI，不是复制 action。十二个默认 target crop 相同；六个变量／inline 控制保留
两个 target OPEN，共 146 原始／128 阈值像素；十八组完整 target／pseudo／ancestor／state
采集记录均相同。十八张 context 是同 cells 的附视图，不新增 pair。有界 same-After 诊断
重现原 Before crop，未证明或关闭原绘制差异。两构建完整输入图仅 consumer 不同，emitted
CSS、OSS main 与 bundled CLI 字节不变。固定环境包含后来拒绝的 122 源码，实际应用
Sidebar 不消费该模块；不能把它作为 122 整合验收。

Login125 仅在既有 DEV Electron email 按钮分支迁移两个尺寸。两份不可变 DEV 源快照
验证实际 served DEV flag；二十二组 target／context 图、完整采集字段及 email／Back
回调相同。production 不渲染该分支，不计 production UI 覆盖。MobileAccount128 把三个
私有 Workspace action glyph 按钮六处 ink 类迁入已有 token；四十八对正式、十六对旧变量、
四对正常动效相同，五十一个非目标 token 不变。两个目标 carrier 与四个直接 primitive-token
负控单列，固定 glyph 私有消费者不授权把此写法推广到任意公开 primitive。

Personal identity130 通过已有 gap Token 与本地 StyleX 迁移私有 Authorize 按钮间距和
响应式 self-alignment，保留两个背景兼容类，因为 owner 没有等价 resting／hover fill
合同。六十六对正向完整物理／非目标记录相同，共1,312个节点及祖先；六十五对目标 PNG
相同，一对 crop 仍有十个原始像素。六十六对 context 相同不关闭该 OPEN。两个直接 gap
Token 写入负控改变几何且单列；不同尺寸目标图不伪造 raw 像素数。

长用户消息131 在固定纯文本 Show more／less 控件迁移两处 ink utility。四十八对正式、
十二对真实 stream、十六对祖先／本元素旧变量结果的 PNG、渲染字段与五十一个非目标
Token 相同；两个目标 carrier 有意变化，四个直接 Token 写入负控仍在私有调用图之外。
四张正常动效图相同，但采集器未正常关闭，仅保留诊断，不算完整验收运行。

helper117 注释迁移二十七处 utility，保留 literal 字体、数字注册及私有 reader／writer
语义；五十四对正向结果保留十五对 raster OPEN（401 原始／零阈值像素）。helper129
迁移十四处真实 fallback utility，另清理一处冗余类不计迁移。它通过实际 React 错误触发
ErrorBoundary，未 mock fallback。十四对正式与十二对完整 native 相同；四对真实 reload／
有效 story 恢复中仍有一对 OPEN（六原始像素）。受控 React 错误是预期证据，不宣称零
console error。宿主真实 light palette 与浏览器偏好分开，viewer 默认仍为 Vesper。
119／123／126 候选均已拒绝回滚：离屏 Checkbox 颜色及继承排版／滚动几何违反完整合同，
即使部分默认截图与记录相同也不接受。不修改 compiler、层、特异性或生产生命周期掩盖失败。

Usage-share133 迁移Description行高与固定QR标签颜色。原utility写入line-height及
`--tw-leading`，不是字号；通过已有owner Token保留reader和writer语义。32个正向cell
的64张目标视图及32张context均exact，992份完整CSS及17,752份Dialog几何记录相同。
仅两个预定局部Token carrier有意变化，原`--tw-leading`严格相等；四个直接Token负控
单列。Field.Label缺少等价字重合同，继续保留物理`font-normal`，不为删类新增API。

helper134 迁移19处私有commit控件outline／focus-ring／transition utility，保留范围外
所有字体、旋转及class选择器。44对正式有43张exact PNG及24,438份相同标准记录。
原40组native的own记录，在明确区分两个私有color／shadow载体的逗号空格后相同，
不宣称raw对象全同。八组原整页几何仍失败；随后八组prewarm截图因实际Tooltip显示
状态未匹配而不同，两批均不算通过。最后一次有界八对用真实Escape关闭Tooltip portal，
保持实际keyboard focus，PNG、完整记录、几何和state均相同。该closed-portal组及八对
single-file补充不替代失败组、不验收open Tooltip。三个原raster OPEN共26原始像素。
不加生产补丁或广泛归一化隐藏它们。截至134的helper精确库存为373／8／21，30份生产
源码对应实际成功构建293份输入；相对392减少19处均为迁移，后续136不在该边界。

Bub135 明确保留最后的`p-0`。真实合法零特异性祖先fixture下，仅移除该类会使四边
padding0→12px、高度16→40px；默认截图曾看似冗余。link variant固定行内padding，
但block reset属于preflight，没有等价既有Button padding API覆盖完整合同。八个诊断cell
保留实际编译规则和截图，源码及运行时迁移信用均为零；不同尺寸crop不伪造raw像素数。

helper136 复用已验focus／transition role迁移FileTreeRow原生控件13处，不改样式定义或
回调。36对正式有35对PNGexact及18,864份相同标准记录；34对native有15对PNGexact、
2,556份物理／state／几何记录同，只有已明确的逗号空格载体差异。十对standalone相同。
二十个原目标OPEN共197原始像素。另一个自然导航desktop pair在左sidebar保留11,423
原始／157阈值像素；原三份限定记录未覆盖sidebar。一次独立有界审计观察到旧main门禁
通过时，sidebar仍有156条150ms有限transition；等待真实稳定后，155节点普通／伪元素
字段同，仅明确class／Token／origin载体不同，新图仍有一raw像素。原时刻缺少这些字段，
因此不证明原因、不关闭旧OPEN；没有添加CSS或回调补丁。

私有muted137 将两个纯文本摘要颜色迁入现代Dialog／Drawer共用description Token，
一个Spinner wrapper颜色迁入本地HSL。30个正向目标／context视图均相同，434份完整记录
及1,114份几何记录相同，只明确分类description Token载体。四个直接Token负控单列，
两种视图覆盖同一变化像素不相加。sharing使用既有合成cloud-capability fixture，不代表
OSS cloud composition覆盖。全部公开编译CSS规则相同，新增description writer仅局部生效。

固定146整合边界通过components620文件／6,209测试，3,200份记录输入全程不变。
790份扫描源码hash同时对应这次稳定测试与实际OSS renderer输入图，三根下界为
1,379／156／727；视觉资格单独记录。新UI owner141独立通过25文件／313测试及类型，
四份owner文件hash固定。146两个renderer构建实际exit0，335份main／CLI／锁文件均未改。
原宽After门禁仍FAIL：两build之间除了consumer，本指南也变化。独立qualified比较只排除
确证未消费的这一Markdown文件，其余3,834份观察输入仅consumer不同，全部产物CSS
字节相同，不改写原完整门禁。此前132默认4GB堆失败、同源8GB成功及四张真实After-only
Electron smoke图继续单列，不是整App原Tailwind baseline。既有根ACP前置失败和旧像素
OPEN均未解除。

helper截至129的精确库存为392处／8个使用文件／21个未解析表达式，30份生产源码逐项
对应实际成功构建293份输入。相对407减少15处，其中14是迁移、1是冗余清理；不含
stories、测试及后续候选。下述主产品库存仍与浏览器覆盖独立。

### 独立字色字段与精确编译条件

控件label Token也可能参与背景计算。139被拒的secondary候选真实改变粗指针hover填色，
四例共9,568原始／3,699阈值像素；六个兼容类已恢复。因此Button141只沿既有字体字段路径
增加可选物理`labelColor`，不新增Token组、variant，不改背景或缺省行为。CSS-wide关键字
到达实际字段，省略值仍使用原style分支；Base UI render元素的style优先级另行验证。
显式inline API不承诺任意DOM／class注入仍保持原优先级：140同元素`.dark`诊断命中真实
Konsta unlayered规则并失败。固定Account调用没有这种class／style／render端口，真实规则
匹配与调用图审计仅支持这个有限范围，不构成公开层叠保证。

96份默认owner完整raw对象全同，94对PNG相同，两对OPEN共347原始／82阈值像素。
152对Account及36对回调的PNG／渲染字段全同，仅360个精确inline-color属性载体不同。
Root独立重读284对原压缩记录并解码PNG，保留两处OPEN。216帧CSS关键字／reference
API检查仅为After-only，不是成对截图。新owner通过UI25文件／313测试及类型检查，四份
owner文件有hash锁；不宣称对整个UI图重新建立了稳定输入门禁。

| 单元                   | 迁移源码utility | 验证边界与遗留限制                                                                                                         |
| ---------------------- | --------------: | -------------------------------------------------------------------------------------------------------------------------- |
| helper原生138          |               9 | 正式48对47相同，native58对40，file14对12；编译特异性提高的两处group-hover颜色恢复，像素OPEN保留。                          |
| Account139／141        |            3 +6 | 保留139 primary，141 secondary采用独立字色；背景耦合失败及139正常动效cleanup缺口保留。                                     |
| PR merge140            |               2 | 60正向对全同；静态hover背景和两字色类保留，两held-touch状态仍NOT_ACCEPTED。                                                |
| helper142              |               8 | 正式55全同，完整134对108相同；分数rem与真实20px初始字体保留原精确条件，26处像素OPEN；另一个清理不计迁移。                  |
| helper143              |              13 | 本地Button可选宽高／字色保留原raw selector和Slot合并，210对204相同；六OPEN共387原始／143阈值像素，错误菜单状态采集仍拒绝。 |
| 私有paste144           |               1 | 24正向target／context对及580完整记录全同；真实34px安全区与vertical-rl圆角反例使padding／radius兼容类保留。                 |
| 固定Mermaid／Banner145 |               2 | 源码2处／运行时5次，144对143相同；一个SVG OPEN4原始／零阈值像素；触摸采集失败和记录缺口仍未验收。                          |

helper的新字段由独立控件拥有，不导入主产品primitive；原raw variant factory和Slot子元素
优先级保持。`<64rem`被编译为`<=63.99rem`会留下真实分数区间差异，142最终保留原
`not all and (width >= 64rem)`精确条件。实际20px初始字体用例区分React1024px挂载
判断与CSS64rem可见阈值；不能凭默认16px截图删除hidden。

paste144保留`calc(var(--spacing) * 0)`及局部initial／inherit语义。直接gap-token负控使
计算gap0→19px，但单内容子元素使PNG相同，属于有效非视觉负控。实际安全区模拟中移除
`p-0`使padding0→34px、高816→850px，竖排模式移除圆角类改变逻辑corner映射。
生产legacy sibling portal host只有源码图证据；fixture验收真实body portal，不冒称运行了
未挂载的nested Composer。这些有界验证不关闭旧Sidebar、像素、portal、原生输入或cleanup失败。

Navigation146迁移真实Electron固定导航按钮一个字色源码出现次数。24正向状态的普通／
伪元素字段、几何、flags和custom值相同，除576个明确继承的`--lody-boot-elapsed`值；
完整raw对象不相同。该变量确实用于boot-shell动画，不称作无reader的诊断数据；目标
观测也不证明整页计算字段相同。21个target及21个context视图相同，三target OPEN共
45原始／14阈值像素，三context OPEN共5,676／261，分别计数。视图覆盖相同状态且有
重叠，不当作独立状态对。两个同元素dark DOM负控不属于固定调用图；点击／Enter／
Meta+B行为全同。原两次零帧采集失败和宽build门禁失败保留，不重采成功帧，也不虚构
像素原因。

### 公开调用方与剩余层叠边界

自147起已接受的有界迁移移除200处源码 utility，含189六处私有间距调用及211／212／214共25处声明与216两处描述consumer。
192两处opacity候选仍保留Tailwind。另六处重复尺寸／shrink单列清理；九个恢复的native编译试验默认值信用零。
215构建adapter仍在隔离验证，尚无已接受迁移信用。

已接受216的全非story components源码为1,325处／145文件／720未解析，覆盖1,397源。
单独冻结的helper214为203处／8文件／21未解析，覆盖30源。合计静态下界为
**1,528处／153文件／741个未解析表达式**，不是精确总量、完成百分比或整branch视觉通过。
扫描方法未变。components精确输入及扫描见inventory-source-through216-accepted-proof.json与
inventory-v2-through216-accepted-fullsrc.json；helper见inventory-helper-source-through214-proof.json与
inventory-helper-v2-after214.json。两套overlay均先核对此前冻结输入，再只应用已接受owner文件。

此前204三个template-class退出未解析计数不是额外utility删除。185手工移除二十literal，但原仅七个
在v2解析范围；保留的h-svh hook及147原字典缺口仍在下界外。198的@lody/ui扫描识别84源零utility，
仍有131未解析表达式；零不证明所有动态类。库存不带来新增整套测试／renderer资格，精确位置及未解析值
保留在冻结JSON；remaining-source-inventory181.html仍是此前181范围。

Tailwind自动扫描也消费源码Markdown中的例子。最终191因迁移指南新增三条arbitrary-property规则，
两个最终实测DOM均无匹配。它们是已输出规则，不是额外产品class出现次数；源码库存不能替代完整CSS
对比。此前CSS不变的测量仍仅对应各自已锁输入范围。

147 实际移除七处，但扫描只减少三处：`CI_ICON_TONE[state]` 原四字符串未被 v2 解析。
这个已知缺口不改变统计方法，也不增加迁移信用。

root160 稳定回归通过 620 文件／6,209 测试，3,208 份记录输入全程不变；全部 790 份
core147 冻结源码 hash 匹配该测试边界，见
`root160-core147-stable-test-qualification.json`。这只建立测试边界，不是新整页渲染／
Electron 采集，也不包含后续 161 源码或隔离 159 原型。各 owning suite 与不可变真实采集
仍分别限定范围。

| 单元                   | 真实渲染结果                                                                                                                             | 保留限制                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal／CI147            | 162对PNG全同，10,034标准及2,864完整目标记录、24回调同                                                                                    | 仅1,008精确class／style载体不同；legacy bar容器定位漏掉portal，不称容器CSS已采。保留旧class浅断言失败，仅删该断言后21owning测试通过；一条新增宽类型lint warning明确记录。                               |
| Shadow／outline148     | 正式30全同，完整86对78同                                                                                                                 | 八个forced-color OPEN356原始／52阈值；精确shadow逗号空格差保留。14注册／fallback及真实无probe生产构建已核。                                                                                             |
| Chevron151             | native96与file16，共112对103PNG同，448完整记录同                                                                                         | 九OPEN874／2；56真实transition事件／时序结构同。截图仅证明稳定端点，不称逐动画帧；未虚构共享formal runner对照。                                                                                         |
| File glyph／shrink152  | 126对117PNG同，2,808完整记录／几何同；三类真实SVG内容和解码尺寸一致                                                                      | 九OPEN69／15；原22部分帧、pointer失败及未完成终止保留。零尺寸glyph不称painted，只用真实键盘恢复不可命中的状态。                                                                                         |
| Cancel153              | 实际Cancel56对50同，全部90正向／参考对77同、656物理记录同                                                                                | 十三OPEN58／0；精确新增inline／private-var载体保留，六private-var负控单列。translate候选在两个实际utility-writer探针中1.98→4px，60,471／52,490，已完整恢复。                                            |
| Delete margin155       | 128对115PNG同，2,514完整记录／几何与真实剪贴板／删除结果同                                                                               | 十三OPEN44／15；另六状态证明实际键盘focus-visible。原十六张Copied／rest图作为before-only保留，权威idle-ready补采另列，不关闭旧OPEN。                                                                    |
| DiffStyleControl158    | 112对103PNG同，1,120完整记录／几何同；真实radio Arrow／Space／pointer及可见modified文件单HTML已验                                        | 九OPEN511／267保留。原24张unpaired PNG、七error记录但仅六完整error图、两次零图discovery失败及一次null-root门禁修正保留。root高度迁移一处，两sm-item重复高度清理信用0；完整CSS、63注册／fallback逐字同。 |
| 解析错误提示160        | 32 对中 29 PNG 同，228 条完整记录／几何同；真实内部 parser 失败、折叠／展开及 standalone 输出已验。                                      | 三个 OPEN 共四原始／二阈值像素。一处 padding 迁移与一处重复 SVG 尺寸清理。原两份 Before build log 被覆盖，仍保留真实退出码／输入／HTTP／driver 证据，不称原日志完整保留。                               |
| 会话配额提示161        | 96 对 PNG 全同，476 条完整记录及四组键盘／指针／触控回调序列同。                                                                         | 188 处精确 class 载体另列，不称整个原始对象相同。Baseline 来自机械提取后的真实呈现 owner，不代表挂载过 stateful quota 或 Electron 分支；原空 label 的零尺寸 button、采集与 QA 失败均保留。              |
| 透明 Checkbox input162 | 63 对已采配对 PNG 全同，但仅 61 对完整对象同；三对实际滚入可见目标的诊断也同。                                                           | 五处候选已恢复，信用零。两组离屏几何／派生颜色差异、native After 与未迁源 file Before 的严格门禁失败、两方向各九个未配对状态均保留；不能据此认定五个样式造成失败。                                      |
| 文件展开状态163        | 48 对中 38 对 PNG／完整记录同，十个实际公开根调用方颜色反转，几何不变。                                                                  | 两类已恢复，信用零；反例 3,990 原始／3,512 阈值像素。即时 coarse tap 的视觉缺口与这些健康配对回归分开。                                                                                                 |
| 私有字距／行高165      | 38 对中 28 PNG 同，806 条目标记录全同；五个明确首组导航状态另有 775 条 sidebar 记录，仅五处图片 URL 端口载体不同，真实 HTTP 资源字节同。 | 十个 OPEN 共 28,779 原始／27,837 阈值像素。原 33 对未采完整 sidebar 状态；新补充证明另一明确交互，不替换旧图；退出及显式 scroll offset ledger 缺失限制保留。                                            |
| Monaco 原生包装166     | 十四个候选对照有 56 条严格原生记录，八个实际公开调用方布局反转，其中两张 PNG 仍相同。                                                    | 四类均恢复，信用零。实际 mobile minHeight0 控制不能证明正值调用方优先级；另八个整个 Monaco 前后几何 OPEN 不属于严格原生证明。                                                                           |

| 私有字重169／172及排版174 | 112 对完整对照中 90 PNG 同；目标、真实 Chrome 字体、sidebar、portal 字段一致，仅精确 logo 端口载体不同，实际 HTTP 图片字节同。 | 二十二个 OPEN 共 838 原始／465 阈值像素。174 的 group-heading 是未迁控制，portal 焦点恢复和未知退出限制保留；native 与 file 分开。 |
| 等宽数字178 | 六处源码；27 对完整对照中 16 PNG 同，1,512 条目标／字体记录同，含真实可见 PR 默认与组合特性端点。 | 十一个完整记录 OPEN 共 775 原始／486 阈值像素；另四个 Copied 反馈对仅有限反馈字段同，增加 57 原始／零阈值像素。原离屏及滚动不匹配 PR 补充拒绝，不替换证据。 |
| 实际聊天 route170 | 十二对真实 Electron PNG 与已采几何同；双主题 1280／820／390 可编辑合成 prompt 保留。 | 两格在 pre/post 共 32 个真实 boot runtime 字段差异，包含实际动画 reader。窄 Electron 仍是 compact desktop，不冒称 mobile／null 分支。 |
| 离线 workspace route173 | 四处；28 对 PNG 与已采字段全同，四组实际 online／offline／Refresh／恢复流程。新 route fixture 恢复又完整复现原 28 个 After。 | 平台 port 是纯内存合成实现，不是实后端／IPC。修正 fixture 在新 route 中使用原组件，不修改导出 route singleton；生成 route tree 排序漂移两源均同，未纳入提交。 |
| 移动集成175与单会话分享标题181 | 各一处；36 与 32 PNG 全同，3,788 与 4,356 scene 记录。覆盖禁用／认证／角色／搜索／Switch 流程及真实字体 Token 边界。 | 移动 role provider 默认值有 12 对控制；分享 origin 在 pre/post 共 128 个精确 URL 载体差异，路径、链接行为与图片字节同。story 旧 effect return 机械显式为 undefined，保留原采集 hash。 |
| Fabric canvas179 | 默认 PNG 与 GPU 像素同，但合法零特异性祖先改变 pointer-events 与真实命中 DIV→CANVAS。 | 两候选 utility 恢复，信用零。默认报告由公开调用方反例补充纠正；像素相同不能接受交互变化。 |
| Content pane182 | 五处owned布局；18对真实Electron PNG与3,242 scene记录同，含实际主题设置、compact遮罩／inert／Escape及焦点回传。 | light767一格保留12个非content hover差。612 boot字段、432生成ID／引用、16blob URL载体单列；32值双射、108引用指向相同节点或同样缺失，trace图片实体字节同。OOM／evaluate／restore原失败保留。 |
| 私有行高183与数字186 | 九处；39／39及20／23 PNG同，495与339目标／字体记录同；table继承length、原48rem reader、导航／reviewed／copy结果保持。 | 186三个OPEN共111原始／72阈值；全部已录字段仅精确图片端口差。183两file运行cleanup未知。完整生产CSS／注册不变，无保活补丁。 |
| 共享layout helper185 | 二十源码literal；46正式对41PNG同，5,118 scene记录；覆盖safearea／keyboard及真实250ms过渡端点，h-svh保留旧浏览器／devbar hook。 | 原五OPEN709原始／零记录阈值；另4诊断OPEN585原始、8复用同源control中4变832原始，均不证明精确原因。三cleanup未知。原矩阵在冻结native试验环境，恢复legacy的独立非空有序资格为3,950 ordinary／2,866 unlayered／8,596非native规则、108注册及18层声明全同，不是新legacy视觉重采。首空组投影无效且原bytes被覆盖，采用另冻的独立proof。 最初after-only环境的16 readiness及16几何失败保留；当时搜索的helper规则缺失且root为content-box。原封不动97行测试随后在已审健康190环境全16通过，preflight实加载、helper／fixture hash匹配，几何、正常250ms过渡、focus／draft原期望未改，持久浏览器测试已恢复。旧32失败与原46视觉对照仍分列；证据为leaves185-persistent-browser-blocked-proof.json与leaves185-healthy190-after-only-verification.json。 |
| 原生时间输入约束190 | 一处隐藏native picker；18 Input完整区域与indicator区域像素全同，78真实UA shadow节点同，键盘与controlled value保持。 | 整图15／18同，三个light390 OPEN2094／2112／2094原始像素、最大channel差1，原因未证。闭合调用图无leading／同pseudo竞争，不替换Input well／字体，也无新primitive API。 |
| helper私有间距189 | 六处调用改用五个可选CSS类型属性。最终六对简写／单边顺序截图与342记录同；原56健康状态有最终源码真实浏览器桥接，覆盖1,360记录，另三组Copied记录同。 | 原56图55同、Copy3图2同，两个OPEN共68原始／43阈值保持。桥接只限定字段，不是新PNG，仅18精确logo端口载体不同。naive merge四个真实失败3922原始／3436阈值保留。只省去被caller／Slot覆盖的API字段以保原顺序；旧尺寸／文字色路径及ToggleRoot Provider行为不变。两次原cleanup未知，四次最终bridge正常关闭。 |
| 私有warning交互191 | 一处Popup pointer-events约束；16对、148目标及1,204 form几何记录仅12精确class载体差。原Positioner拦截、失焦及窄story裁剪保持。 | 12PNG同、4个光标位置OPEN共72原始／72阈值，未推断时序原因。配对After含隔离192候选；另191-only最终构建与Root输入同。文档扫描新增三条未使用arbitrary-property utility，既有规则／注册顺序全同。最终观察仅After-only补充，不是新配对PNG。 |
| 真实未同步子页193 | 两处尺寸类使用现有Spinner diameter API。11对真实Electron PNG／RGBA全同，77目标、176祖先和3,443几何记录一致；22次Back均恢复主会话。 | 原始对象不同：957个精确boot时钟／生成ID字段与44个绑定／尺寸载体单列。真实900ms旋转固定在400ms相位采样，不证明所有自然动画帧。另八处无法触达或无法稳定hold的pending尺寸仍保留Tailwind。 |
| 登录交接链接194 | 两处尺寸类使用现有Button width／height属性。32对扩展链接区域及实时canvas外像素同；另4对原生reduced-motion整图PNG／RGBA全同。Tab、Enter、指针激活和真实handoff href同。 | 正常动效32个整图OPEN全部保留，共191,628原始／阈值像素，均在WebGL canvas内，不虚构精确绘制原因。同源sandbox fixture阻止外部协议启动并记录手动激活，验收实际post-transfer UI，不证明OS交接。两个精确legal链接origin、frame环境及绑定载体差异另列。 |
| 用量Skeleton195 | 三处调用方utility迁入可选inline和bar／tile形状。44对真实浏览器PNG／RGBA及14,732完整节点记录全同；六个新增Gallery视图为After-only。既有形状、可选尺寸、本地spacing与mini圆角11已验。 | bar保line默认高度和mini底角，仅顶角3px；tile为20%圆角，不加高度或宽高比，方形仍归调用方。错误依赖来源的44帧After整组拒绝并保留；最终workspace解析精确追溯实际新UI源。四对正常脉动使用400ms固定相位，不证明自然时间线同步。 |
| 私有审阅Checkbox196 | 七处utility迁入本地input／glyph样式，保留精确zero-spacing表达式及原生状态／事件。原20个默认dark对18PNG同；另两CSS-wide与两真正5px对全同。真实指针／Tab／Space、目录半选及reload清零行为保持。 | 原两个单像素OPEN与17个raw差异项（含全节点列表不匹配）保留。同源真实滚动证明112px占位块会变534px diff host，解释422px机制，但历史observer时机未证。另一个已加载滚动对像素、45目标及560几何记录同。旧phoneSpacing5标识实际为默认Vesperdark，以更正sidecar及真正5px补充区分；原provider固定dark，light未覆盖。 |
| 加入工作区Textarea197 | 一处私有min-height使用既有本元素field Token，保留精确spacing表达式。44对PNG／RGBA与644节点的物理CSS、其它变量、状态和几何同；实际controlled输入、1000字符上限与提交禁用行为同。 | 完整raw对象有44个class、132个目标Token载体与36个精确头像URL端口差异，两URL经独立HTTP读取为相同PNG bytes。原严格失败保留。根／本地spacing、zero、initial／inherit／unset及祖先Token覆盖已按所列交替宽度覆盖，不冒称完整笛卡尔矩阵。 |
| 字段标签字重198 | 字段组labelWeight Token默认500，由Field.Label读取。三个固定Login标签保留本地medium变量及私有writer；21个Login／QR正式整图全同，含380、initial400及inherit／unset500；原QR font-normal仍为400。Root融合后25个UI文件／313测试及两包类型通过。 | 两个默认Gallery对的原控件ROI同；新增实际测量500／620两行使高度明确增加172px，与产品等价单列。两个同元素font-semibold负控物理600同，但私有writer600→500；一张dark光标图18像素OPEN保留。reduced即时读值过渡证据保留，settled及实际normal0s行为同，不宣称全部自然中间帧一致。 |
| 移动／QR标签字重200 | 四个固定标签复用规范field Token及精确medium／normal writer。48个严格pre/post状态保持198目标、11,798对话框几何、实际字体、Range及legacy writer；45整图同。 | 三个Share820 OPEN共30原始／零阈值像素，位于已记录目标框外，绘制原因未知；仅66个class及102个Token载体精确单列。实际状态使用默认4px spacing，不声称也无需为纯字重调用补5px覆盖。 |
| 工作区底色201 | 一处私有背景utility迁入既有helper的有限page／sidebar选项；默认page／settings输出逐字不变，实际非settings根互斥选择sidebar原子。十二个真实Electron状态中，74根观测的背景与3,406几何同，11对PNG／RGBA同。 | 原一个Logo OPEN共239原始／零阈值像素，原因未知。启动viewport640／1280、真实boot标记／elapsed读者、12个CSS URL及10个精确ID／ARIA路径单列，不声称启动历史相同。自有App退出后1222renderer及335guards完整还原。原8598规则／802at-rule保序，仅新增一个背景原子，原根class无hook。 |
| Login间距／图标202–203 | 一处私有提交margin及一处固定后代尺寸utility迁为本地StyleX。提交十二对、SVG十对PNG／RGBA全同；六个固定glyph保18px、原display／shrink及Lucide表现属性。生产与真实自然DEV覆盖第六Mail，provider点击／disabled和email焦点／Back行为同。融合203的working tree通过619组件文件／6,199测试；既有用户修改属于测试输入，不是纯提交renderer验收。 | 提交记录精确列24class及72规则路由变化；图标记录列84class、两个固定DEV debug-source属性、42匹配规则投影及24个CSS URL载体，其余raw无差。原误达Unverified及采集失败仍拒绝；Resend缺fixture错误code未覆盖。图标构建仅删除原important后代规则，复用既有atom。 |
| Card标题排版204 | 两个可选物理属性保留默认600／本地semantic tracking reader，三个认证标题移除五utility且保留legacy变量writer。十五个真实浏览器consumer用例中五个反例拒绝alias／fallback方案，支持物理声明。51个实际／变量页面整viewport及四个原Gallery Card ROI的PNG／RGBA全同；471记录、1,468几何仅有102个精确标题class／inline载体变化。 | 四个新增Gallery行仅After-only。两侧collector均因相同48条既有styleq日志、四条坏头像console错误／四个abort请求exit1；页面格没有这些错误。最终正常清理成功，首个selector拒绝轮的未知清理边界保留。没有新增Token组、全局CSS保留规则或fallback补丁。 |
| 私有review标签207 | 十五个原生label基础utility迁为本地StyleX，保原变量及medium writer。原十六对PNG／RGBA、112目标记录除精确class／CSS URL载体外同；两个受影响profile另以真实wheel／scrollend／返回操作验证，六对应stage全部字段、几何、extent、命中及原PNG同。源码逆变换及737保留CSS规则／182 at-rule逐项同。真正inline-only单文件补八个原生状态对，桌面四对PNG／RGBA同；另两个真实导航场景最终nav／滚动字段及PNG同。 | 手机单文件四对保留34原始／零阈值像素，原reader缺nav属性；新增fresh lazy／observer历史差异及相同横向滚动边界全保。原两个initial状态保留348个文档extent／后续位置差异，幅度446.5px；原8,562几何记录全保。离屏600／153.5状态符合原content-visibility intrinsic-size机制，但旧cache／fixture历史没有记录，具体原因未证。采用私有声明不代表全部初始整页状态相同，没有虚构14状态代码子集或修改lazy／content-visibility。实际主题固定Vesper dark。 |
| 原生review状态208 | 六个hover／checked／transition源码utility迁为原生CSS谓词；hover仅在无checked后代时生效，保留原checked胜出，不用React状态或特异性补丁。二十Storybook对保140目标、10,949几何，十九PNG同；八个真实native事件保持即时checked谓词与字段。另四个真实分组导航场景的目标／nav完整字段及PNG同。 | 一张Storybook留36原始／零阈值OPEN；八单文件对中四桌面保侧栏高亮差，共112,516原始／106,504阈值，四手机同。原reader缺nav属性，新增四nav-ready仅1280，不关闭旧history／具体原因。八个无关storage key缺失→[]差异精确列出，活动key与initialComments优先reader已核。whole at-rule顺序不全同；733保留规则／context／顺序及scoped树同。 |
| 私有Button字重210 | 一个可选物理fontWeight字段保默认500及省略时原style路径。两个源码utility、五固定读取点保原变量与private writer。68真实整viewport对、830记录、1,594几何除352精确class／inline载体外同；106份CSS完整字节同。实际callback、pending／disabled及平台字体同，十新Gallery状态仅After-only。 | CSS字面weight0无效：Chrome从550更新0仍550；合法var()解析0则继承333。原JSDOM0断言保并改成合法initial关键词，UI25／314与两包类型通过。额外原生夹具控件完整字段仍作control；首次目标分类失败及Gallery26条console诊断／两阻断请求保留。 |
| 私有Checkbox211 | 十五个wrapper／material／transition utility迁为本地StyleX；native input、ref、effect、事件及glyph不变。十五正式对加一个mixed-directory焦点补充对PNG／RGBA全同，保778目标、688导航及8,381几何记录。 | 仅240 wrapper class及四固定CSS URL载体变化。63注册及733保留规则原序同，whole at-rule185→183不同。原forceExpanded准备漂移保留；最终门禁以真实折叠再展开确认，不注入状态。 |
| Modal标题字重212 | Dialog.Title与Drawer.Title新增可选物理fontWeight，保默认600及省略时原style对象。四consumer utility覆盖五条真实标题路径；54正式对PNG／RGBA同，270记录／1,112几何仅88精确class／inline载体不同，106 CSS文件字节同。 | 十六Gallery视图仅After-only；保Base UI render／hidden／ARIA，不虚构Title.asChild。采集后lint清理另有最终bundle DOM资格，不称重采54图。原caret修改、Gallery transition／readiness失败及缺失旧terminal DOM证据保留。 |
| 原生焦点环214 | 六个ReviewCheck／Checkbox焦点utility迁为原生:has(:focus-visible)，无React焦点状态或marker。十一对保519目标、473导航及5,759几何，九PNG／RGBA同；物理box-shadow严格同。 | 原两OPEN保1,968原始／1,632阈值像素，位于header角及group标题文字，具体原因未知。三十个具名ring color／shadow逗号空白差异保两侧raw并逐项核锁定语法／consumer，不称raw对象相同。63注册及732保留规则同，whole at-rule183→181不同。207／208旧OPEN不关闭。 |
| Legacy描述字号216 | Vaul-backed DrawerDescription新增物理fontSize，保省略路径、caller style及Radix child优先级。移除两处工作区面板utility及原被覆盖的重复StyleX字号。22正式对保66完整目标／祖先记录、464几何及36精确class／style载体，21 PNG／RGBA同。真实输入、blocked／pending及关闭重开重置保留。 | 原light390输入聚焦状态保719原始／零阈值像素、最大通道差9，位于目标描述之外；具体原因未知，未采input完整computed。十二API状态仅After-only。真实CSS仅删除旧utility规则，模块图仅少一条已无用pure helper import。浮点／readiness及过强图oracle失败保留，不称真正工作区创建成功。 |
| ShareCard阴影反例 | 真实公开className后代shadow-none规则Before胜出，After被无层StyleX私有writer压过。三utility候选拒绝，信用零，Root源码未改。 | 一个真实端点两侧各自采集内49完整后代记录稳定，但物理大阴影改变；95,906原始／12,307阈值像素不同。原高亮readiness／准备失败保留在next-native-share-card-counter-acceptance.html；只拒绝已证明候选，不表示所有未来ShareCard迁移均阻塞。 |
| Spinner透明度192与queued pulse | 两opacity候选拒绝：4个direct控制同，4个真实零特异性祖先使0.7→1，共721原始像素；Root源码未改。 | 旧named默认在utilities中凭特异性胜出，普通StyleX则早于caller utility层，直接替换不能保合同。另完整animation变量简写在锁定compiler模式下不产CSS；默认keyframes不能替代元素本地变量合同。未采用compiler模式、新primitive API或特异性补丁。 |
| Native编译试验188 | 三个真实arbitrary-property调用方使strip598→16px、viewport598→840px、裁切／命中改变，默认与named控制仍同。 | 十三试集成路径全恢复，六新增文件及三临时依赖link已移除，cache包未删。九默认仍Tailwind。此前66对成功与实际App312原始OPEN只保留为证据，不作接受结论。 |

提示的原 18 个样式字段、原生 DOM 和父级回调原样移出；配额、翻译、telemetry 与 settings
仍由原页面负责。父级最终仅清理一个空悬注释，其 runtime token AST 与构建输入同，
不称字节 hash 相同。八处 amber 替换保留本元素 palette 变量、包含 light-scope 排除的
精确自身／祖先 dark 谓词、fine-pointer hover，以及编译器原 color-mix 能力查询与 fallback。
直接使用 `when.ancestor` 会引入 marker 要求，并不等价。这个呈现 owner 让真实状态可被
独立验收，没有复制 UI，也没有增加另一套配额策略。

字距／行高单元同时保留原私有写入和物理 reader：tracking 直接读 theme 变量或字面值，
leading-tight 读 `--leading-tight`，而非 `--tw-leading`。去掉诊断 story utility 的完整
production 构建仍通过真实 StyleX CSS 引用保留 `--tracking-wide`；独立去引用控制才将
默认值 prune。没有新增 static 保活补丁，也没改 CSS 文件。精确源码与扫描下界见
`inventory-helper-source-through165-proof.json` 与 `inventory-helper-v2-after165.json`。
原不匹配的 sidebar 状态和像素 OPEN 保留，不用目标字段相同掩盖它们。font-weight 同样直接读元素局部主题 Token，同时保留私有 writer。
等宽数字不同：物理声明按编译器原 empty fallback 读取完整五个数字变量。
完整 Storybook 与 standalone 输出的数字 atoms、注册与默认值一致；没有 static 保活补丁
或通用样式逃生 API。

公开组合带来真实阻塞，默认截图不足。Assistant actions149保留六类：四个受支持自定义
Icon Token reader在发布间距Token后6→9px或10→18px，八个受支持Stream unlayered调用
在物理inline字色下改变颜色，八个低特异性控制同。这二十组明确是DOM-only拟议字段校准，
不是产品After或迁移；coarse-hover门禁失败及四个未采手机状态保留，View产品字节不变。

Adaptive150保留九布局：18控制同，18祖先和两opaque调用失败，其中六张祖先PNG相同，
但overflow／container type已变，仍拒绝。Progress154在四个真实公开Sidebar调用回归后
保留height／flex：height4→48px、track4→6px，或track宽218.125→0、fill82.875→0。
另外38个默认／变量／动效匹配对不能接受这四反例。Outline157保留padding：实际named
popup host带回公开零特异性祖先，使12→48px，局部spacing下18→72px；另一个控制的
popup本体同，但整页十二像素OPEN原因未定。320px Rail确实被抑制，不是locator缺失即
误称popup关闭。候选均已恢复，迁移信用为零。

隔离156实验提供一条[仍为proposed的有限路径](../../proposed/architecture/2026-10-31-stylex-cascade-compatibility.zh.md)：
独立namespace／前缀、Tailwind之前utilities本层，十三个原生Adaptive用例可同，但不保
任意Slot顺序。后置注入破坏其他Slot／query／caller，共享atom又改变普通StyleX overflow，
即使PNG同也失败；原生子层与双unplugin实例不能代替隔离提取。没有改产品compiler、
依赖、锁文件或全局层序，没有采纳通用兼容路径；继续闭合owned范围，并保留这些具体合同。

## 后续工作

基于编译器的[用量统计](../../../../packages/components/scripts/tailwind-usage.mjs)
用锁定 Tailwind 编译器验证 AST 中发现的候选。数字是源码出现次数下界，不是运行时覆盖率、
生成 CSS 体积或完成率；未解析表达式保留为独立工作清单。

| 源码边界                                    | 扫描方法 | 出现次数 | 文件 | 未解析 |
| ------------------------------------------- | -------- | -------: | ---: | -----: |
| 冻结 29–30                                  | v1       |    1,736 |  175 |    721 |
| 冻结 31–33                                  | v1       |    1,715 |  175 |    717 |
| 相同 pre31 源码快照                         | v2       |    1,741 |  176 |    725 |
| 冻结截至 35 的源码                          | v2       |    1,705 |  175 |    721 |
| 冻结截至 40 的源码                          | v2       |    1,676 |  175 |    721 |
| 冻结截至 43 的源码                          | v2       |    1,664 |  173 |    721 |
| 冻结截至 45 的源码                          | v2       |    1,656 |  171 |    721 |
| 冻结截至 47 的源码                          | v2       |    1,646 |  169 |    721 |
| 精确截至 49 的源码                          | v2       |    1,637 |  169 |    721 |
| 精确截至 54 的源码，视觉限制另列            | v2       |    1,620 |  168 |    721 |
| 精确截至 59 的源码，不含后续候选            | v2       |    1,602 |  168 |    722 |
| 精确截至 63 的源码，视觉部分验收            | v2       |    1,594 |  167 |    722 |
| 精确截至 67 的源码，视觉部分验收            | v2       |    1,572 |  166 |    718 |
| 精确截至 71 的源码，视觉部分验收            | v2       |    1,554 |  165 |    718 |
| 精确截至 73 的源码，视觉部分验收            | v2       |    1,542 |  165 |    718 |
| 精确截至 78 的源码，视觉部分验收            | v2       |    1,507 |  163 |    718 |
| 精确截至 81 的源码，视觉部分验收            | v2       |    1,489 |  163 |    724 |
| 精确截至 84 的源码，视觉部分验收            | v2       |    1,474 |  163 |    726 |
| 精确截至 88 的源码，视觉部分验收            | v2       |    1,451 |  159 |    726 |
| 精确截至 93 的源码，视觉部分验收            | v2       |    1,445 |  157 |    725 |
| 精确截至 95 的源码，视觉部分验收            | v2       |    1,430 |  157 |    725 |
| 精确截至 99 的源码，视觉部分验收            | v2       |    1,424 |  157 |    725 |
| 精确截至 120 产品源码，含最终 Search118     | v2       |    1,414 |  157 |    726 |
| 截至128的合格产品源码，排除后续131／130     | v2       |    1,404 |  157 |    725 |
| 132实际固定主产品，含130／131且排除133／134 | v2       |    1,399 |  157 |    726 |
| 截至145观察源码，未获全套回归资格           | v2       |    1,380 |  156 |    727 |
| 146合格主产品；稳定全套与实际renderer源码   | v2       |    1,379 |  156 |    727 |

截至145的source-only快照在扫描前两次核对790个相同canonical路径：components946／140／634，
legacy UI429／14／93，routes5／2／0。这是新源码库存，不替代固定132全套测试／renderer
边界；19处净减对应后续已接受主组件源码删除，不关闭任何部分视觉范围。helper143另为
329／8／21，覆盖30份生产源码。
同一source-only边界还冻结全部1,396份非story产品src：1,389处／158个使用文件／731未解析，
重叠790份hash全部相同。三根外九处出现次数和四个未解析表达式独立记录，不产生新的
扫描方法迁移credit。

更早的方法修正覆盖了单个 utility、`withClassName` 第二参数和受支持的静态类名数组。
各批历史数字继续留在冻结报告，不能跨方法混合基线。例如四文件 helper 重扫得到 165→97，
不会把移入 helper 的保留 utility 当作删除；部分已迁移的运行时布局字面量也不在静态计数内。

扫描器 v2 新增点式／字面量括号式 `className` 直接赋值，修复明确的 iframe 漏项：
v1 漏记五个真实 utility，因此 31–33 批实际移除 26，而旧下界仅减少 21。原扫描器源码及
统计保留；v2 在独立的精确 pre31 快照重建 1,741 基线，不改写已冻结的 1,736 报告。
功能性解析测试覆盖别名、按源码位置去重、直接写入、动态／复合写入，以及比较表达式和
其他字段中看似有效 utility 的负控。模糊写入继续列为未解析；UI 适配器两处 `className` 写入新增四个未解析表达式，
因此数量相应增加。

已发布截至 99 的 v2 分项为 components 990 处／141 文件／632 未解析，旧 UI 429／14／93，
routes 五处／两文件／零，来自三根 790 份冻结源码。共享 UI 源码与导出元数据位于该计数
范围外单独冻结。已知 StyleX 模板继续作为未解析表达式，不代表新增 Tailwind 字符串。
截至 88 仍是独立不可变库存；八处源码删除加两个新可见的保留 margin，使数字净减六。
94–95 再移除十五处源码出现次数，97／99 再移除六处；较广的截至 95 库存仍保留历史边界，
不含后续批次或其他包宿主。

截至 95 的完整产品 `src` 审计排除 stories，仍用同一 v2 扫描器；1,396 份冻结 JS／TS 得到
1,439 处／159 文件／729 未解析。截至 88 的全域库存 1,460／161／730 保持原样。三根外九处属于 `conversation-layout.ts` 与
`use-keyboard-aware-scroll-into-view.ts`，另四个未解析单列。独立的截至 88 手工锁定编译器审计还发现 v2
漏计十六个潜在 skip-link 工厂字面量、三个共享 touch-helper 字面量及六个调用方 margin
参数；其中两个 margin 参数在 92 调用迁移后可静态识别，其余四个仍不透明。
skip-link 工厂仓内没有调用，安装新 link 不能证明迁移了原 UI。已知解析缺口与已发布
下界分开，审计不给迁移 credit，也不重写历史统计。真实 touch 调用需要已有 Button 尺寸
API 和各自视觉证据，不能用 opaque caller class 与 primitive 争优先级。
此前截至 67 时，五个 Usage 模板表达式和一个 Archive
类查找消失，新增两个 FileError／Bub
StyleX 模板未解析，它们不代表新增未知 Tailwind utility。另一次 helper 审查在 lib／hooks 两个文件中发现另外九处，位于三根范围之外；
不混入同边界总数，也不称为新增产品
回归。比较这部分后续工作前，应明确扩展 inventory 范围。34–39 批视觉差异与被拒校准保持各自状态，
源码统计不构成验收。

以上库存总数均针对 `packages/components/src`，不是整个 monorepo。Electron 渲染入口
导入该包的 Tailwind 样式；开发面板的普通 CSS hook 不计作 utility 删除。独立的
`packages/code-review-helper` 渲染器与 `site-docs` 各自拥有 Tailwind 编译管线，不纳入
这些库存。helper 的 findings／引用批次已有上文独立编译与单文件证据，其余 helper 区域及
site-docs 仍需独立基线，不能由组件截图隐式验收。
隔离 ACP demo／编辑器应用不在本次迁移范围，也不需要子模块操作。

WebWorkspaceLayout现通过共享helper的有限surface选项拥有背景；Sidebar控件兼容项仍保留。上文已有真实
Electron content／layout与健康布局浏览器测试的有界证据，但不证明每条保留规则都已验收。
helper gutter Button的尺寸utility也保留：本次真实Before的hover、行批注及Split路径均未
渲染该Button。leaves199-baseline-blocked-proof.json记录实际空gutter slots和
ReviewRenderer.tsx的renderGutterUtility回调；须先建立真实可达状态，再迁移尺寸，
不能为了迁移信用改变原功能。

未使用的 `src/ui/sidebar.tsx` 保留 303 处，`src/ui/index.ts` 没有重导出它；
公开通配路径仍可能被外部直接导入。其公开适配层现有真实渲染夹具，包含移动打开及桌面折叠。
未使用的 `src/components/task-list.tsx` 保留 14 处，
`src/components/sidebar-updated-task-list.tsx` 保留 22 处；两者现有真实渲染及原生输入夹具。
`PropertyRowWide` 现有真实渲染夹具，仅保留两个任意子元素选择器。其他未使用界面
仍需先确认消费者并建立场景，再迁移。原版 phone 终端错误 span 宽度为零、
行内反馈不可见，而桌面/平板/短视口反馈可见；原版 240px 日程场景中极长 label 与不可收缩
Button 会重叠。这些边界保留并记录，没有借样式迁移重新设计。

搜索场景验证过程披露展开、普通文本及 Markdown mark；场景缺少挂载 thought 正文和
ThoughtCard 所需的 builtin/DeepSeek SessionMeta，因此这两者未获视觉覆盖。
`sessions/session-search-context.tsx` 保留的五处容器 ring/shadow utility 原样未迁，
也未经过视觉验证；先补齐元数据、确认正文实际挂载，再迁移并验收这些保留规则。

原版底角打开的批注卡片可能超出 `overflow: hidden` 画布并裁切底部。触摸 Resolve
在完整可见的原生卡片上验证，没有通过自动化将裁切卡片静默滚入视野后宣称自然触摸路径
可用。`ghostValueClass` 合同及 PinButton 控件兼容项继续保留。trusted Chromium 触摸输入不证明原生 iOS 或 WebKit 行为；自定义 VS Code
主题也未全部实测。

继续处理保留的聊天/移动控件覆盖、Emoji Picker / Drawer 遗留兼容类、diff 适配层、其他旧 `src/ui` 包装及第三方后代选择器。侧栏兼容项仍需
自有祖先 marker 与控件级样式组合。控件兼容应与自有 DOM 样式分开处理。硬编码 dark 变体需要保留
元素局部的精确主题条件，FilterPillBar 现已如此处理；自有祖先状态使用限定 marker。
其余变体仍需分别验证调用方和作用域。报告记录
最终实测清单和未验收状态的准确位置，包括文件/Issue 元数据浮层及原生手势。本次截图
不证明所有远程/后端流程或每种主题均已覆盖。
