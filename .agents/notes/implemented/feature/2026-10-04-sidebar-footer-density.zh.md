# 紧凑的侧边栏底部控件

Status: implemented
Translation: current

[English](2026-10-04-sidebar-footer-density.md)

## 摘要

桌面 workspace 入口原来高 32px，旁边的操作按钮只有 24px，导致悬停区域显得过厚。
四个控件现在统一使用 UI primitive 的 28px small 尺寸，头像保持 20px，操作图标为
16px。移动端保留 48px 点击区域。浏览器测量与截图覆盖组件场景；完整应用验证仍受
当前 checkout 的既有依赖缺失与类型错误限制。

## 决策

[LoroSidebar](../../../../packages/components/src/components/loro-sidebar.tsx)
负责底栏组合。桌面控件使用 ghost Button，尺寸、悬停与焦点由 primitive 提供。
本地静态身份使用相同行高，但不变成按钮。外层使用 flex，避免 inline 按钮的基线
行盒额外撑高底栏。当前归档入口使用独立选中背景与 `aria-current`，保留按钮自身
的视觉契约。移动端在 48px 点击区域内提供 20px 图标容器，避免图标溢出 primitive
的 16px 图标容器。

桌面端所有相邻控件之间统一留 4px，包括 workspace 与帮助按钮。
浏览器覆盖测量全部三个间隔。
在相同侧栏宽度下，操作组及其与 workspace 的间距比原始底栏合计多占 8px，
长名称仍可省略。全部设为 32px 会保留底栏的厚重感；全部缩为 24px 则只给 workspace
头像留下上下各 2px。共享的 small 尺寸兼顾紧凑度与鼠标点击区域。

本决策补充[入口顺序决策](2026-09-26-sidebar-footer.zh.md)，仅替换
[阅读对比度决策](2026-09-24-reading-contrast.zh.md)中的底栏选中样式。
产品意图由仍为 draft 的[底栏 Spec](../../../../specs/sidebar-footer.zh.md)维护。

## 验证与限制

现有侧栏和 workspace 身份测试覆盖选择、同步状态、静态身份与底栏入口，24 项全部
通过；两项 Playwright 底栏检查也通过。
浏览器覆盖放在现有侧栏布局测试中，使用
[底栏 stories](../../../../packages/components/src/stories/SidebarFooter.stories.tsx)
检查明暗主题、长名称、同步与静态身份，并覆盖界面字号 12、14、18。
移动端覆盖真实点击尺寸与菜单操作。Playwright 在相同暗色场景、视口、设备缩放
和 workspace 悬停状态下截取修改前后图片；生成图片放在已忽略的
`artifacts/sidebar-footer/` 中。

修改前控件为 32px 与 24px，底栏实测 41px。修改后控件均为 28px，底栏实测 37px，
包括 Chromium 对分隔线宽度的取整。局部 lint 与根目录 `pnpm format` 通过，文档检查没有新增
基线之外的错误。完整 `pnpm check` 因缺失 `fumadocs-mdx` 工具而停止；组件类型检查
遇到无关的文档预览依赖缺失，以及既有 Markdown 和运行时类型错误。
本次不声称已启动 Electron 应用或取得
Spec 的人工审批。
