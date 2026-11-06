# Tailwind 到 StyleX 迁移

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875)（草稿）

[English](2026-10-22-tailwind-to-stylex-migration.md)

## 摘要

Lody 共享产品 UI 已使用直接 StyleX，替代依赖 Tailwind 的声明桥。Electron renderer 与独立 review helper 不再使用 Tailwind 构建插件和运行时 class 合并依赖。组件通过必要的 typed 入口组合实际调用方样式，保留有效布局、主题和交互状态。Storybook 示例也已迁移，临时编译输入、共享 preset 和组件包剩余编译依赖均已移除；真实截图差异和未访问状态继续保持开放。构建成功或字面量归零不代表迁移完成。

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

## 后续工作

最终冻结的编译器 v3 快照扫描 1,795 份源码，识别 utility 为零，另有 744 处未解析表达式，范围包括产品组件及全部 stories。之后退役扫描器、其测试和编译依赖；原始工具及最终 JSON 保存在 ignored 产物。早期零计数曾漏掉真实映射，因此动态 producer 审查与该静态下界分开记录。

示例覆盖通过实际 owner／part 入口组合，包括 DiffViewer、列表加载状态与移动端 tab 图标尺寸。纯 Tailwind 排序诊断已退役，保留有意义的 Slot、几何、交互与截图覆盖。退役后的 Storybook 生产构建成功，1,923 份输入无变化；MobileNewChatSheet 明暗主题／390 与 820 宽度的 16 对真实截图全部像素一致，四帧仅记录删除透明零阴影载体的 computed 差异。其它新迁示例不据此视为视觉通过；此前报告及 OPEN 帧未改。

库存范围是共享产品源码及示例。`site-docs` 另有独立 Fumadocs／Tailwind 管线；首批原生页面（NotFound 与 Legal 宽度）已改为本地 StyleX，使用站点自己的插件配置，不引产品 UI。SSR 开发文档绕过 Vite HTML transform，必须显式加载官方 virtual stylesheet／runtime；生产按 Vite environment 创建独立插件实例，并明确提取到共享 index CSS；复用 SSR／client 插件状态曾使页面 CSS 重新哈希后留下旧 manifest 引用，该失败构建已拒绝。修正构建完成 272 份静态 HTML，所有本地 CSS 引用有效。404 的三对真实开发截图像素及记录布局相同，Legal 只有 After 检查，不冒称成对验收。既有 Fumadocs／未迁样式仍需编译器，站点直接声明自己的动画 CSS 依赖，不再借用产品已退役依赖。StyleX 位于 utilities 层之后：CSSOM 证实 Fumadocs prose 默认值也在 utilities 层，放在其前会丢失原局部 margin；不能靠任意 opaque caller 优先级维持，应一并迁移真实 owner 与 typed 调用方。最初缺 CSS、列表间距及外部边框差异帧继续保留；未证明的全页边框和 language-open 差异保持 OPEN。隔离 ACP demo／编辑器应用不在本次 UI 任务内，也不需要子模块操作。

早期计数、阶段决策与拒绝实验保存在冻结产物及[先前已提交 Note](https://github.com/LodyAI/Lody/blob/11390b40320b01a8f5807850de65a011253cedda/.agents/notes/implemented/architecture/2026-10-22-tailwind-to-stylex-migration.zh.md)。它们限定历史证据，不覆盖当前所有权，也不关闭旧视觉失败。
