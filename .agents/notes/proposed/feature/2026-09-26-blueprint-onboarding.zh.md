# 蓝图式 Onboarding：把配置做成给真实窗口"上墨"

Status: proposed
Translation: current

[English](2026-09-26-blueprint-onboarding.md)

## 摘要

现在的桌面 onboarding 是一张表单悬浮在被淡化、模糊的产品窗口上；窗口里还预置了一段编造的、跑到一半的对话；
Agent 步骤的镜头指向一个并不存在的锚点——表单和产品的"幽灵"是两件割裂的东西。本提案把整个配置放到同一个对象上：
真实的 `TourApp` 窗口一开始是一张从它自己布局实时描出来的铅笔线稿，每个回答把它所配置的那一块"上墨"成真实 UI——
选 Agent 让 run-config 按钮显影，选项目让侧栏显影，第一个任务直接在真实 composer 里输入、用真实发送按钮发出；
配置期间窗口按屏幕尺寸完整排版，答案写在它的标题栏里；最后窗口长满屏幕，直接成为产品本身。Storybook 原型（`Onboarding/Blueprint`）用 fixture 数据跑通了
本地流程；它尚未接入 `OnboardingOverlay`，并且替换了已批准的插画 Intro——这需要 owner 决定。

## 问题（证据）

- `STEP_FRAME.providers` 指向 `composer.run-config`，但没有任何节点带这个锚点，`measureAnchor` 退回整个窗口并按
  `maxScale 1.8` 放大，窗口被裁在舞台右侧。
- 预览使用 `STILL_TRACKS`（`reveal: 9`、`tasks: 4`）：在用户还没有 Agent、没有项目时，就显示一段跑到一半的假对话、
  假会话和侧栏默认的 "Temperature of the sun" 聊天。
- 镜头层透明度 48–65%，叠 40px 背景模糊和网格，产品读起来像幽灵而不是一个地方；收起的侧面板还画出 1px 边框，
  在窗口右缘留下缺口。

## 提案

- **描摹而不是插画。** `blueprint/sketch.ts` 遍历每个区域的实时 DOM，记录文字行、控件、有填充或阴影的表面和单边分隔线，
  画成石墨线：文字是长短不一的"词段"，方框画两遍（第二遍更淡），线宽在屏幕空间恒定；所有区域共用一张纸，有底色的区域（侧栏）随上墨才出现底色，不再画排线。
  线稿从布局量出，所以永远跟随产品布局。
- **上墨即进度。** 未配置的区域被纸和铅笔盖住；回答后从相关控件处在纸上开出圆形的洞（`SketchLayer`，一个 SVG mask）。
  当前问题的目标区域用 accent 色线条描绘，不加色块。
- **问题是画出来的，不是列出来的**（第二轮：owner 认为"popover + 列表行"不够 wow）。问题是画布上的排版标题；选项画在它将来所在的位置、
  并处于真实状态：铅笔 = 这台 Mac 上还没有，墨 = 已经有。Agent 是 composer 上方的一排卡片，Lody 正在获取的运行时是一张从底部涨墨的卡——
  墨的高度就是下载进度；本地文件夹是墨卡片（已经在这台 Mac 上），"Choose a folder…"是铅笔卡片；建议任务是画在第一条消息位置上的铅笔气泡。
  所有问题都在同一个地方提出——composer 上方的空对话区；只有答案会移动，飞向它所设置的控件。composer 就是输入框
  （`FieldOverlay` 通过产品的 `setInputText` 回写文字），真实的发送箭头就是 Run（`PressOverlay`）。
- **选中即作答。** 选项化成 V2 凸起小胶囊沿弧线飞进它的控件（`AnswerFlight`），落地处开始羽化显影并有一圈 accent 湿墨光环，
  显影后自动进入下一步；回改通过顶部导轨。
- **铅笔讲 V2 材质语言**：凸起的表面下方有一笔接地线，凹陷的输入框顶部内侧有一笔阴影；开场先画蓝色构造线，再画细节。
- **一个完整的对象。** 配置期间 `TourStill` 的 `windowSize` 把窗口按屏幕尺寸减去桌面边距排版（限制在 1024×640–1700×1080），
  所以窗口始终以 1:1 完整可见：标题栏、边缘、阴影都在，不会被裁成一条。开场稍微拉远；问题之间镜头不再平移。交接时整个窗口从 composer 处上墨，
  用户自己的提示词成为第一条消息和标签页标题；随后 `TourStill` 新增的 `windowSize` 让窗口按屏幕尺寸重新排版，
  假标题栏移出画面，最后一帧就是产品自己的布局。
- **导轨就是窗口的标题**：写在窗口标题栏里，逐项陈述答案：`Agent Claude Code · Project lody · First task …`。

## 为原型所做的产品改动

- `DesktopRunConfigMenu` 给触发按钮加 `data-run-config-trigger`；`resolveAnchor` 派生出 `composer.run-config`、`composer.input`、
  `composer.card`、`composer.send` 和 `sidebar.workspace`——这也修复了现有 providers 镜头的问题。
- 配置预览中的 `TourApp`：没有聊天、分支为 `main`、在发送之前对话为空（没有假气泡、没有运行中标签、没有 "No messages"），
  发送后以用户提示词作为第一条消息、标签页标题和该项目在侧栏的第一行会话；收起的侧面板不再画边框。
- `LoroSidebar` 的演示用 `repoSections` 路径（只有 tour 使用）在项目没有会话时不再渲染玻璃托盘——它之前显示成一个空的圆角框。
- `TourStill`：新增 `overlay`、`windowShadow`、`windowSize`，并给 `TourApp` 包一层独立层叠上下文，避免产品内部抬起的节点压过 overlay。镜头还会监听窗口自身尺寸，`windowSize` 变化时重新取景，而不是停在旧画面上。

## 设计评审轮次（Technique 3）

三位全新上下文的评审只看截图、使用同一提示词，分别打出 5、5、4 分，且互相矛盾：前两轮要求面板与控件间加引导线，
第三轮要求去掉；第一轮要求统一细线，第二轮说细线像骨架屏。只采纳各轮共同指出的问题：铅笔对比度、多余接缝、统一镜头规则、
未选中 Agent 不显示进度、文案更平实。去掉面板阴影和圆角的建议没有采纳，因为会破坏 `@lody/ui` 的浮层层级。
评审循环因不收敛而停止，owner 的评审才是真正的关口。

## Owner 评审第三轮

Owner 对第二轮原型指出四点，以上均已处理：导轨放在单独的顶部条里，与下方窗口融不到一起（1:1 时窗口被裁，上缘在条下被切断）；
侧栏线条太多（排线、accent 线、铅笔项目行和一个空托盘）；项目问题应该放在空对话区而不是侧栏；交接后项目下本该出现新会话行的地方
是一个空框。代价是去掉了问题之间的镜头平移和速度倾斜——它们之所以存在，只是因为 1700×1080 的窗口以 1:1 显示在更小的屏幕上。
Owner 还提出了类似 Balatro（小丑牌）的像素风作为另一个方向，尚未决定。

## 未完成 / 待定

- 尚未接入 `OnboardingOverlay`：真实的 `AgentConfig`/`ProviderSetupTask` 行、认证面板、失败文案映射、原生文件夹选择器、
  埋点、完成与恢复仍由现有页面负责。
- 云端章节（登录、Workspace）已有锚点（`sidebar.workspace`）但还没有面板；紧凑窗口（<1080px）、线稿与上墨之外的减弱动效、
  `zh_CN` 文案都未处理。
- 替换四段插画 Intro 与 `onboarding/AGENTS.md` 相冲突，需要 owner 先批准。
- 仅在 Storybook（Chromium，1440×900）中通过脚本化走查验证，没有在 Electron 中运行；Electron E2E 构建在共享机器内存压力下
  两次被 SIGTERM。没有新增自动化测试；现有 tour 与 onboarding 测试全部通过。
