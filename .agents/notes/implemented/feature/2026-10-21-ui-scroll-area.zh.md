# 滚动区域迁入 Base UI 组件体系

Status: implemented
Translation: current

[English](2026-10-21-ui-scroll-area.md)

## 摘要

Lody 的设置、侧边栏和查看器仍使用 Radix 滚动区域包装组件，原生列表则需要
手动添加旧 CSS 类，否则显示浏览器默认外观。现在滚动区域归入 `@lody/ui`：
Base UI 负责测量和输入，StyleX token 负责中性灰滑块、透明轨道及交互状态。
所有产品调用方迁到这一实现；原生控件共享外观，同时保留原有滚动和键盘行为
的负责方。旧包装组件、依赖和供应商专用补丁一并移除。

## 决策与范围

本次完成[数字和密码输入框迁移](2026-09-20-ui-number-password-fields.md)中
推迟的滚动区域工作。新组件提供 `axis`、`visibility`、`compact` 和原生
`viewportRef`。调用方保留布局和溢出边界，组件包统一轨道尺寸，以及灰阶中的
静止、悬停、按下颜色。侧边栏继续仅在滚动时显示滚动条；紧凑横向标签栏使用
`compact`。

Menu/ContextMenu、Popover、Select/Combobox、Textarea、Table 和 Drawer 中
的原生滚动区域共用 StyleX 滚动条样式。产品容器使用低优先级的 CSS 基础样式，
其取值通过调色板作用域内的桥接来自同一组 token，从而覆盖已有原生容器，
无需替换它们的节点。对话引擎的稳定滚动槽、显式隐藏滚动条和终端标签栏尺寸
均保留，不引入第二套滚动控制器。

Base UI 的 Content 部件替代 Radix 隐式的 `display: table` 包装。纵向内容使用
`min-width: 0`，横向内容允许超出视口。文件树虚拟化和滚动恢复继续持有真实
视口引用。差异面板直接接收该引用；调用方和已有检查改用稳定的
`data-scroll-area-viewport` 标记，不再依赖供应商属性。

生产依赖完全移除后，[Radix 轮询补丁](../bug-fix/2026-09-15-scroll-area-frame-cleanup.zh.md)
随之退役。历史补丁和包装组件链接指向原始源码快照。现有生命周期检查改为
面向公开组件的事件驱动采样、视口节点稳定性及卸载后的视口清理。不改动
Base UI 版本或包边界。

共享 jsdom 环境在缺少 `Element.getAnimations()` 时提供空动画集合：jsdom 不运行
Web Animations，而 Base UI 会在测量前检查子树动画。把这个边界放在共享环境中，
能覆盖所有真实 ScrollArea 调用方。Base UI 的禁用动画开关保留 jsdom 原有的
同步弹窗收尾行为；退出动画测试显式开启它自己控制的动画。生产行为保持不变，
测试错误也不会被忽略。

## 证据与限制

Gallery 在两种强制调色板下展示真实组件、尺寸、全部滑块颜色、纵向和双向滚动。
产品 Storybook 示例还包含原生溢出、长菜单、Textarea 以及隐藏滚动条。
Chromium 中检查了滚轮、滑块拖动和键盘焦点；600 项文件树仍保留受限行窗口，
紧凑横向标签可以滚动，开源声明弹窗在较矮窗口中也能滚动。全仓类型检查、
格式化、类型感知 lint、i18n、边界和文档检查通过。`NODE_ENV=test pnpm check`
通过，包括全部 594 个组件测试文件和 25 个 `@lody/ui` 测试文件。六个针对性套件
覆盖原有 API 缺失、弹窗关闭和受控退出动画，共 25 个测试通过。未验证打包后的
Electron、触摸输入或非 Chromium 引擎。
