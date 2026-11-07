# StyleX 迁移：主分支集成

Status: implemented
Translation: current

[English](2026-11-07-stylex-main-integration.md)

## 摘要

此次集成同时保留主分支产品行为和本地 StyleX 所有权。验证采用 main 选定的依赖版本和补丁，避免陈旧类型声明被误当作合并回归。

## 决策

将 main `053466e5d36643032f28bb81784c9e830307faa0` 集成到迁移提交
`f5d2890144aaf3b08d23227c8d3e5212de913fe4`，在隔离工作区解决 133 个冲突路径。
同时保留 main 产品行为和本地 StyleX 所有权；仅消除文本冲突不代表集成正确。

| 范围   | 保留的合同                                                                                    |
| ------ | --------------------------------------------------------------------------------------------- |
| 移动端 | 整页新聊天、折叠面板、原生键盘 inset、边缘手势和设置导航。                                    |
| 对话   | 引用插入／撤销、prompt suggestion、归档恢复、分享／导出能力门控和下部折叠布局。               |
| 侧栏   | 分屏／拆分拖拽意图、成组标签、键盘选择和 Android 预览生命周期。                               |
| 队列   | 共享行高与 gutter、内缩 tile、roomy／airy／touch 布局，以及 pending／scheduled 行行为。       |
| 样式   | 不恢复 Tailwind 编译器或声明桥接；main 新增 utility 消费者改为本地 StyleX 和 owner 类型属性。 |
| 测试   | 保留 main 对浅层 class／源码断言的删除，同时保留输入、ref、浮层、键盘与状态转换行为覆盖。     |

`ScrollArea.contentFullHeight` 直接作用于其拥有的 Content part，支持全高折叠布局。
不增加 wrapper，也不把原始后代 selector namespace 强制转换为 `StyleXStyles`。
InlinePicker 和折叠面板在各自同一 `stylex.props` 中合成新增布局约束。

## 依赖和验证边界

合并锁文件在仅含 manifest 的临时 workspace 使用 pnpm 10.20.0 重新生成，并通过
离线 `--frozen-lockfile` 检查。采用准确 gitlink manifest；本地缺少对象时只读获取
对应 manifest，不修改子模块 checkout 或源码来解决 UI 冲突。

UI 验证采用隔离模块链接及 main 已选择的版本／补丁。引用转换器共享 HAST 类型
覆写；streams 包包含 main 的 snapshot-recovery 补丁；准确的 ACP core 临时副本
使用锁定 SDK 构建。这样无需修改产品代码迎合陈旧的本地类型声明。

生产 Storybook 和真实浏览器验证覆盖具有代表性的合并 UI，不关闭历史视觉 OPEN，
也不代表所有 runtime／cloud 分支均已验收。既有
[迁移](2026-10-22-tailwind-to-stylex-migration.zh.md)和
[设计系统](2026-11-07-design-system-convergence.zh.md)证据保持原范围。
用户工作区的 112 处原有未提交改动不进入此次隔离集成。
