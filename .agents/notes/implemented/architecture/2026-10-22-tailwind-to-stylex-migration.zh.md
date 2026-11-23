# Tailwind 到 StyleX 迁移

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875)

[English](2026-10-22-tailwind-to-stylex-migration.md)

## 摘要

共享产品 UI 使用本地 StyleX 和 typed primitive 组合。Electron renderer 与 review helper 不再依赖 Tailwind 编译器。公共文档站点不属于此次迁移范围。编译成功不代表视觉兼容。

后续[设计系统收敛](2026-11-07-design-system-convergence.zh.md)会有意替换迁移时保留的旧透明度与材质覆盖；其新外观验收与原迁移等价性分开。

## 所有权与组合

[产品样式层](../../../../packages/components/src/style/README.md)拥有应用颜色和尺度；[迁移指南](../../../../packages/components/src/style/MIGRATION.md)拥有具体组合及采集规则。样式位于组件本地 `stylex.create`，只有区域内重复结构才提取到相邻 surface。语义化 primitive 参数仍是常规设计 API。

需要物理覆盖的实际调用方使用 typed `xstyle` 或明确的 part 参数。primitive 在自身一处 StyleX 表达式中组合默认值，并转发动态变量和原有 style callback；省略参数时保持原行为。原生集成 marker、第三方样式表及字体可以保留普通 CSS，但不应成为替代 utility 引擎。

声明桥、配置表、Vite 插件及专用测试已删除，Vite、Storybook、Vitest、Electron 接线同步移除。它们仍保留 Tailwind 的排序引擎，不是迁移终点。[桥接决策](2026-10-31-stylex-cascade-compatibility.md)现在是历史记录，不是恢复该架构的依据。

产品 CSS 不再导入 Tailwind、Konsta 或动画工具包，不含编译指令和 `--tw-*` 私有状态。带许可的浏览器 reset 位于 `src/tailwind/reset.css`，普通尺度默认值与原生安全区位于 `theme-defaults.css`。历史目录／导出名字不加载编译器。Storybook 临时示例样式表与编译插件、无用的共享 preset 及依赖编译器的库存工具均已移除；Electron 的 Tailwind 插件、旧配置和依赖，以及组件运行时 CVA、Konsta、合并依赖均已移除。review helper 的独立管线也已退役。
