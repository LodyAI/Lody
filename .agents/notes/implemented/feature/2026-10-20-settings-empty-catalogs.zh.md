# 带插画的设置目录空状态

Status: implemented
Translation: current
PR: [#1745](https://github.com/LodyAI/Lody/pull/1745)

[English](2026-10-20-settings-empty-catalogs.md)

## 摘要

设置目录为空时，原先只显示一张写着“没有”的记录卡片。
现在直接在页面上居中展示 Lody 水母插画与本地化文字，原有提示和操作说明保持原文。
共用组件也覆盖已有项目、GitHub、分享、Provider
的空状态，以及空的项目 Skills 目录。已有添加入口继续可用，插画仅作装饰。
数据归属、加载条件、权限、错误状态和非空列表均保持原有行为。

## 决定

本次替换[设置节奏决定](2026-09-25-settings-rhythm-and-image-peek.md#design-review-round-2)
中的空目录展示方式。`SettingsEmptyList` 直接绘制在页面上，不再使用
`settingsRecordsCard`。共用 StyleX 布局由设置 surface 管理，并新增可选说明文字。
组件内部没有滚动区域，文字能在窄面板内换行。页面保留已有添加按钮；原有的可选
操作区域仍能承载 GitHub 安装入口，不会额外重复页面的添加动作。

原有中英文文案逐字保留，包括标点和操作说明，不新增引导文案。
可选描述承载项目 Skills 已有的提示。
已保存的记忆关联与外部记忆目录为空时共用同样的展示方式。项目 Skills 只在目录
确实为空时使用插画，错误重试与搜索未命中的提示继续单独显示。
没有改变目录写入、Provider 请求、选择规则或能力开关。

## 插画

新的[透明 PNG](../../../../packages/components/src/assets/settings-empty-jellyfish.png)
由内置 `image_gen` 工具生成，以现有 `lody-icon.png` 作为品牌参考。蓝绿色水母拿着
放大镜寻找空文件夹，没有内嵌文字或限定主题的背景。
[生成提示词](../../../../packages/components/src/assets/settings-empty-jellyfish.prompt.txt)
与素材一同保存。图片作为公共包的本地资源，使用空 alt 和 `aria-hidden` 标记为装饰，
相邻文字负责传达信息。

## 验证

组件类型检查、类型感知 lint、翻译键验证，以及已有记忆、MCP、Prompt Shortcut
表单测试共 17 项通过。两个桌面浏览器案例分别使用英文/亮色/1180px 与
中文/暗色/500px，覆盖六种空目录的图片加载、居中、换行、没有空卡片或内部滚动区、
已有添加弹窗，以及加载和只读状态。两个手机案例在 393×852 触屏视口下检查角色与
MCP 的亮暗主题。四个浏览器案例均通过；本地使用 Chromium build 1223，并允许
Storybook 在 30 秒内完成渲染。

`pnpm format` 通过。最新完整 `pnpm check` 的类型检查与 lint 通过，但未修改的
iOS 模拟器面板测试有一项在五秒后超时，组件测试其余 5,742 项通过。
所属 25 项测试单独运行全部通过；CLI 测试 4,423 项通过、四项跳过。
翻译和边界检查另行运行均通过，因此不能将此次全仓检查记为全绿。
文档检查保留原有六个 Kimi/Pi 子模块缺失链接，没有新增错误或保护主题变化。

## 截图

修改前后的截图以附件形式放在 [PR #1745](https://github.com/LodyAI/Lody/pull/1745)，不纳入仓库。
使用真实目录组件与合成示例数据采集。桌面视口为 1180×800，截图聚焦内容区域；
手机使用正式的 `MobileSettingsLayout`，触屏视口为 393×852。两端均包含亮暗主题，
每组前后对照使用相同的示例数据和视口。
