# Tailwind 到 StyleX 迁移

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875)（草稿）

[English](2026-10-22-tailwind-to-stylex-migration.md)

## 摘要

Lody 共享产品 UI 已使用直接 StyleX，替代依赖 Tailwind 的声明桥。Electron renderer 与独立 review helper 不再使用 Tailwind 构建插件和运行时 class 合并依赖。组件通过必要的 typed 入口组合实际调用方样式，保留有效布局、主题和交互状态。Storybook 示例与公共网站也已迁移，其 Tailwind 编译输入和直接构建依赖均已移除。站点以本地 StyleX 皮肤和语义阅读 CSS 组合公开 Fumadocs 行为 API；真实截图差异和未访问状态继续保持开放。构建成功或字面量归零不代表迁移完成。

## 所有权与组合

[产品样式层](../../../../packages/components/src/style/README.md)拥有应用颜色和尺度；[迁移指南](../../../../packages/components/src/style/MIGRATION.md)拥有具体组合及采集规则。样式位于组件本地 `stylex.create`，只有区域内重复结构才提取到相邻 surface。语义化 primitive 参数仍是常规设计 API。

需要物理覆盖的实际调用方使用 typed `xstyle` 或明确的 part 参数。primitive 在自身一处 StyleX 表达式中组合默认值，并转发动态变量和原有 style callback；省略参数时保持原行为。原生集成 marker、第三方样式表及字体可以保留普通 CSS，但不应成为替代 utility 引擎。

声明桥、配置表、Vite 插件及专用测试已删除，Vite、Storybook、Vitest、Electron 接线同步移除。它们仍保留 Tailwind 的排序引擎，不是迁移终点。[桥接决策](2026-10-31-stylex-cascade-compatibility.md)现在是历史记录，不是恢复该架构的依据。

产品 CSS 不再导入 Tailwind、Konsta 或动画工具包，不含编译指令和 `--tw-*` 私有状态。带许可的浏览器 reset 位于 `src/tailwind/reset.css`，普通尺度默认值与原生安全区位于 `theme-defaults.css`。历史目录／导出名字不加载编译器。Storybook 临时示例样式表与编译插件、无用的共享 preset 及依赖编译器的库存工具均已移除；Electron 的 Tailwind 插件、旧配置和依赖，以及组件运行时 CVA、Konsta、合并依赖均已移除。review helper 的独立管线也已退役。

## 真实浏览器支持的决策

- 保留原版实际生效的级联。原本失效的 Mermaid `!my-5` 在直接迁移后突然生效，把 16px 间距变成 20px；删除死覆盖才恢复实际布局。合并 PR 颜色和 Goal 状态映射需要明确的 StyleX，不能改成继承色或保留运行时 utility 字符串。
- 条件 `default: null` 会擦除 primitive 的静止属性。真实检查发现过 well 阴影、placeholder 色、次级填充、padding、pointer 状态丢失；在 owner 内完整表达所需状态，不添加特异性补丁。
- 锁定版本的编译器支持局部后代选择器。Markdown 直接拥有表格、数学和文件链接规则；真实调用方使用 part 样式和 `flush` 展示参数，不能依据早期“不支持后代”的说法永久保留 utility。
- 保留逻辑 margin 和 `space-y` 的 block／子元素 margin 模型，不改成 flex/gap。早期真实完整构建中的私有 writer 顺序失败确实存在，即便独立 Babel 探针通过。直接迁移移除该私有基底，不修改编译器掩盖问题。
- 颜色保留原 HSL／color-mix 表达式和局部变量读取；字体也包括连字行为。主题别名在声明位置解析，局部 palette／spacing 覆盖必须位于真实 scope。部分 `createTheme` 会安装不相关默认值；[主题／字体决策](2026-11-03-stylex-font-writer-pair.md)与迁移指南保留已观察到的边界。
- 小写 JSX 节点也可能是 primitive 的 Slot／`render` 子元素。将它的 utility 改成 opaque StyleX class，可能丢失原调用方优先级。应迁移真实父级组合入口，并核对禁用、选中、hover 和静止状态。一次性源码转换工具必须先拒绝这些入口，解析真实调用方后再处理；逐声明相等不能证明组合结果相等。
- 隐藏 label 也有有效盒子。剩余 Storybook `sr-only` 清除了新 StyleX label 的原 padding，把 4×12 改为 1×1。应迁移调用方到 typed 样式，不把原本失效的 padding0 顺便变成有效声明。

首次 renderer smoke 虽完成导航，仍未通过视觉验收：根布局的 `h-svh` marker 只有旧浏览器 fallback，现代 Electron 因而坍缩到内容高度。根布局现直接用 StyleX 声明 `100svh`，语义 `workspace-viewport` hook 服务 native fallback 与 devbar；真实 smoke 同时校验视口几何。拒绝截图与修正后的七个页面／状态截图分开保留。

## 验证及证据边界

当前不可变 Storybook 检查点记录真实构建 exit0，2,302 份输入哈希未变化。主要产品矩阵有 180 对，176 对 PNG 精确一致，4 对 OPEN。其中一对的故事外部两个 Button 有 1,482 raw／12 阈上像素，其余为 1／2／1 raw，不能统一称为抗锯齿。增加真实控件就绪条件后的三对补充图一致，但不能据此独立证明原帧差异原因。

固定 SMIL 的附件十二对中，六对一致、六对 OPEN，固定 SVG 时间没有关闭残差。十六对 Mention 图像相同，却在该检查点存在真实隐藏 label 几何失败；后续调用方修正单独验收。基础 CSS 的 24 对／1,932 节点比较属于开发环境隔离检查，不是第二份生产构建。即便 PNG 相同，透明或零尺寸阴影载体删除仍记录为原始 CSS 差异。

修正后的真实 OSS Electron renderer 记录 1,516 份输入不变，产物 CSS 不含 Tailwind 私有状态或生成标记。隔离真实 Electron 截图覆盖 onboarding、agent configuration、explore、local chat，以及日／周／月日程交互；工作区尺寸与 1284×786 视口一致。这是应用 After-only 截图，不是原版完整应用基线。

组件回归 619 文件／6,197 测试通过；UI 检查点 25 文件／320 测试通过，后续 Select 样式入口有 owning 行为测试及类型检查。typed UI lint 和 public boundary 检查通过。根 `pnpm check` 仍在既有 Codex ACP SDK export 解析构建阶段阻塞，后续检查未运行；本迁移不修改或同步该子系统。测试结果始终对应各自源码检查点。

比较来源也是验收的一部分。独立审计发现两份早期 controls 汇总在两侧都读了 Before 相对路径，其 36 对引用为 INVALID。原图和错误汇总保留，修正比较分别读取各自 manifest、PNG 和真实浏览器记录。来源有效不代表不同的图像通过。当前自包含 `direct-stylex-acceptance.html` 和 `direct-*` 证据位于 `packages/components/artifacts/visual/`；历史报告及其中 OPEN 原样保留。

## 网站迁移与后续验收

产品最终 v3 编译快照扫描 1,795 份源码，识别 utility 为零，另有 744 处未解析表达式；之后退役扫描器、测试及编译依赖，精确输入和 JSON 保存在 ignored 产物。网站退役前的编译快照中，149 份自有文件（组件 70、路由／页面 47、lib 32）识别 utility 为零，组件另有 39 处未解析表达式。39 处实际 producer 已追查，均为 StyleX 输出、普通 CSS 状态或语义 hook，未发现站内动态 Tailwind。这些快照仍是静态下界，不是视觉或任意外部运行时字符串覆盖。

网站 primitive 与真实调用方组合本地 StyleX。旧语义样式表的 111 个 `@apply` 改为原选择器下的普通声明；首屏 body、预览滚动锁、布局 inset 与热图圆点改用明确 data hook。站点同时替换 Fumadocs preset、safelist 和 typography 编译器：[本地文档皮肤](../../../../site-docs/components/docs-ui/README.md)提供 layout／page slots、导航、搜索和 MDX 部件。状态及交互继续使用公开 Fumadocs contexts、框架链接、scrollspy、TOC 测量轨道和 Base UI 行为。布局尺寸根据实际语义部件写在祖先上，不把变量错误声明在子节点。布局拥有语义 `fd-page-tree-item-name` marker 的物理皮肤。

阅读排版与 Shiki token／行集成采用语义普通 CSS；`reading` 层位于组件 StyleX 之前。`DocsBody` 将标题相邻及正文首尾子元素的 margin 结构保留在 StyleX；移入更低的 typography 层曾改变原本对 Tabs 间距的优先级。主题默认值、浏览器 normalization 和文档 palette 保留有效变量及 MIT 许可，不包含 utility 规则。站点不再使用 Tailwind 构建插件、preset 导入或直接编译依赖。精确版本的 [Fumadocs patch](../../../../patches/@fumadocs__base-ui@16.8.12.patch)只将 `dist/utils/cn.js` 从 `twMerge` 改为 `clsx`；workspace 规则移除该版本的 `tailwind-merge`／`@fumadocs/tailwind` 依赖边，并提供 `clsx@2.1.1`。补丁保留 class 拼接，不保留 utility 冲突解析，因此物理样式覆盖应在本地 owner 组合。定向 offline frozen install 已通过，实际安装的 `cn` 模块导入 `clsx`；根锁文件没有 Tailwind 包节点。这些依赖检查不证明视觉全等。

站点拥有独立插件配置，不引产品 UI。SSR 开发文档绕过 Vite HTML transform，需要显式加载官方 virtual CSS／runtime；生产按 Vite environment 创建独立插件实例，并提取到共享 index CSS。复用 SSR／client 实例曾留下过期资源引用，该产物保持拒绝。最终层顺序为 `theme`、`base`、`components`、`reading`、`site-stylex`，不承诺任意 opaque caller 优先级。

| 遗留边界           | 位置                                                                                      | 后续方案                                                         |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 尚未通过的视觉状态 | ignored 产物中的 `direct-stylex-acceptance.html`、`site-stylex-migration.html` 及来源记录 | 保留源码检查点、失败候选和 OPEN 差异；成功子集不能关闭无关失败。 |

无编译器的文档皮肤构建生成 272 份静态 HTML，样式表引用全部有效，没有 Tailwind 生成标记或私有状态。站点类型、lint、30 项 owning 测试及九项生产静态导航检查通过。真实浏览器三对截图覆盖桌面深色 First Session、桌面浅色 Quickstart、移动中文深色 First Session：858 个节点矩形全部一致，两张 First Session 图像像素全等；Quickstart 的 32 个原始差异像素仍为 OPEN，未证明栅格原因。已实际操作搜索键盘选择／导航、语言切换、移动 TOC 链接及关闭。`docs-stylex-skin-acceptance.html` 内嵌这三对及拒绝候选；这一有限覆盖不代表每个文档组件状态均已验收。

已有的编译器退役前网站构建生成 272 份静态 HTML，所有 CSS 引用有效；该检查点的类型检查和既有静态导航九项通过。原移动端测试错误选中隐藏导航链接，失败记录保留，定位器修为实际博客内容链接。网站报告内嵌 21 对分检查点截图；此前开发环境 404 三对像素及记录布局一致，Legal 只有 After 检查。缺 CSS、列表间距、外部边框、language-open、Spinner 时钟及异步 Diff 帧继续保留。这些结果不能验收后续每个本地文档皮肤，也不能证明最终视觉全等；源码迁完不替换其状态。

这不代表整个 monorepo 无 Tailwind 依赖，也不代表所有迁移状态通过视觉验收。隔离 ACP demo／编辑器应用仍在本任务之外，无需子模块操作。早期计数与拒绝实验保存在冻结产物及[先前已提交 Note](https://github.com/LodyAI/Lody/blob/11390b40320b01a8f5807850de65a011253cedda/.agents/notes/implemented/architecture/2026-10-22-tailwind-to-stylex-migration.zh.md)。
