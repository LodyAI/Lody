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

## 后续工作

基于编译器的[用量统计](../../../../packages/components/scripts/tailwind-usage.mjs)
替换了会漏掉单个 utility 和多种值的旧正则。工具扫描 JSX、类名 helper、常量及模板静态
片段，以锁定编译器验证候选，并单列动态未解析表达式。计数是源码出现次数的下界，不是
运行时覆盖率或生成 CSS 体积。

此前九文件续迁使 components 用量从 2,377 处降至 2,100 处，审计下界为 3,093 处，
component 扫描另列 605 个未解析表达式。后续七文件再将 components 从 2,100 处降至 1,907 处。
共享适配层批次再将 `src/ui` 从 992 处降至 742 处。Emoji Picker / Drawer 批次将 `src/ui` 进一步降至 626 处。Diff Viewer 批次进一步将 `src/ui` 降至 518 处。合入前透明度续迁后的审计下界
为 2,421 处：components 1,902、`src/ui` 518、routes 1，共 188 个仍含 utility 的文件。
扫描器另列 690 个未解析表达式：components 600 个、`src/ui` 90 个。
合入上游新增代码后，当前扫描为 2,572 处（components 2,054、`src/ui` 517、routes 1），
共 188 个文件；另有 692 个未解析表达式（components 611、`src/ui` 81）。
这些数值是下界，不是全项目完成百分比。

未使用的 `src/ui/sidebar.tsx` 保留 324 处，`src/ui/index.ts` 没有重导出它；
公开通配路径仍可能被外部直接导入。
未使用的 `src/components/task-list.tsx` 保留 87 处，
`src/components/sidebar-updated-task-list.tsx` 保留 95 处，
`src/components/schedules/schedule-property-row.tsx` 未使用的 `PropertyRowWide` 导出保留
20 处；先确认实际消费者并建立渲染场景，再迁移。原版 phone 终端错误 span 宽度为零、
行内反馈不可见，而桌面/平板/短视口反馈可见；原版 240px 日程场景中极长 label 与不可收缩
Button 会重叠。这些边界保留并记录，没有借样式迁移重新设计。

搜索场景验证过程披露展开、普通文本及 Markdown mark；场景缺少挂载 thought 正文和
ThoughtCard 所需的 builtin/DeepSeek SessionMeta，因此这两者未获视觉覆盖。
`sessions/session-search-context.tsx` 保留的五处容器 ring/shadow utility 原样未迁，
也未经过视觉验证；先补齐元数据、确认正文实际挂载，再迁移并验收这些保留规则。

原版底角打开的批注卡片可能超出 `overflow: hidden` 画布并裁切底部。触摸 Resolve
在完整可见的原生卡片上验证，没有通过自动化将裁切卡片静默滚入视野后宣称自然触摸路径
可用。Recurrence 原有两个 dark 变体、`ghostValueClass` 合同及 PinButton 控件兼容项
继续保留。trusted Chromium 触摸输入不证明原生 iOS 或 WebKit 行为；自定义 VS Code
主题也未全部实测。

继续处理保留的聊天/移动控件覆盖、Emoji Picker / Drawer 遗留兼容类、diff 适配层、其他旧 `src/ui` 包装及第三方后代选择器。侧栏兼容项仍需
自有祖先 marker 与控件级样式组合。控件兼容应与自有 DOM 样式分开处理。硬编码 dark 变体需要明确的
marker/主题合同；StyleX 有关系选择器，这属于剩余实现范围而非库的绝对限制。报告记录
最终实测清单和未验收状态的准确位置，包括文件/Issue 元数据浮层及原生手势。本次截图
不证明所有远程/后端流程或每种主题均已覆盖。
