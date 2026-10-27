# 移动端新建对话复用消息页及首次发送的页面呈现

Status: implemented
Translation: current

[English](2026-10-28-mobile-new-chat-page.md)

## 摘要

移动端新建对话现在复用真实消息页的头部、返回按钮和底部输入框，把机器和项目放在
输入框上方的页内区域。它替代独立 sheet 和拥挤的底部横向控制栏，Role、Agent、Model、
Mode 仍使用共用的运行配置 Sheet。首次发送成功后保留新建页，直到会话内容真正呈现，
并在延迟挂载和 URL 修正期间持续关闭入场动画。真实组件的浏览器检查通过，iOS 开发版
已安装；原生键盘和真机发送的手感仍需用户验收。

## 决定与范围

本决定取代[先前 compose sheet 决定](2026-10-27-mobile-new-chat-compose-sheet.zh.md)
中的布局和机器锁定方案。先前工作改编自
[@natsustan](https://github.com/natsustan) 的
[#491](https://github.com/LodyAI/Lody/pull/491)，其贡献归属继续保留。

- 复用 `SessionConversationPage`、`BaseHeader`、`MobileSessionHeaderBackButton`、
  `ConversationColumn` 和进行中会话的输入框外壳。两处共用键盘偏移、安全区和过渡。
- 机器在前、项目在后，各为图标和值，不单独占用标签行。机器、项目和分支在原地展开。
  本地 Git 的 worktree 与分支共用一行，两种主题下都没有背景；直接使用本地目录时
  分支只读，因为它使用当前已检出的分支。GitHub 提供分支选择。
- Role、Agent、Model、Mode 留在 `MobileSessionRunConfig` 及其原有 Sheet。
  共用入口使用正常字重，长模型名保留开头。切换机器会清除不兼容的 Role 和本地项目，
  机器选项明确提示对 Role 的影响；草稿保留。
- 无项目显示“未选择项目”。项目组用 Folders，本地目录用 FolderOpen，GitHub 选项和
  选中入口复用桌面端的 owner 头像；加载中或失败时显示 GitHub 图标，不显示仓库描述。
  全部来源共用桌面排序：最近使用优先，再按名称和稳定标识；不再用创建时间提高未使用
  目录的优先级。搜索只过滤而不重排；未选择项目、添加目录、连接仓库保持固定位置。

## 首次发送的职责

Landing 在会话创建接受前保留受控草稿和附件，沿用既有失败恢复与消息派发行为。
`getSessionCreationNavigation` 在 history 中记录对应会话的创建请求。
`useMobileComposerPresentation` 按会话及 history index 保留该次创建入口，
同一 history 项的 URL 替换不会丢失状态。宿主在本次创建的会话页面打开期间持续向
Drawer 传递关闭入场动画的标记。

`SessionDetail` 在 layout effect 中确认已经呈现解析完成的移动端会话内容。
只有这个确认才消费 history 请求并隐藏保留的新建页。导航 Promise 完成不能代替内容
呈现：Portal 和实际会话可能稍后才挂载。Vaul 的 `defaultOpen` 优化也只覆盖第一帧，
因此内容和遮罩明确关闭入场动画。拖动、关闭、返回及后续普通访问保持既有过渡。

## 验证与限制

- 项目、目标、workspace、运行配置、提交及桌面比较器的相关套件共通过 110 项测试，
  包括既有头像缓存、项目过滤及比较器边界。
- 八个浏览器场景覆盖深浅主题、320–430px 手机宽度、固定模拟 300px 键盘、延迟呈现、
  后续 URL 修正，以及 GitHub 头像等待、成功、失败状态。首次发送场景观察 45 帧，
  输入框边界、模型文案和字重不变，没有入场位移。
- 组件包类型检查、改动文件格式与 lint、画板布局检查通过。仓库文档检查仍受未初始化
  ACP 子模块的链接限制；仓库级检查结果另在 PR 中说明。
- Story 强制使用移动端布局分支，真实组件配合合成 workspace 和提交结果。画板包含
  各种项目、展开选择器、共用运行配置 Sheet、附件、长文本和短屏。
- iOS Debug `0.107.2 (20261028.3)` 已构建、签名、安装并启动到真机。安装成功和
  模拟布局检查不能代替原生键盘时序与首次发送手感的验收。
