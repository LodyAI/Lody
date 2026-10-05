# 文件链接首次点击的行号定位

Status: implemented
Translation: current

[English](2026-10-05-file-link-line-navigation.md)

## 摘要

带行号的文件链接可能在首次点击时只打开文件顶部，第二次点击才到达目标行。
原先的定位只移动视口，Monaco 光标仍在第 1 行，因此首次语言初始化和折行布局可能覆盖
尚未完成的滚动。修复将光标同步移到目标行，并立即定位；行范围装饰复用 Monaco 自带的
主题样式 `rangeHighlight`，替换没有 CSS 定义的自定义类。已在安装版应用中复现问题，
并以真实 Storybook 和隔离的 Monaco 测试验证源码修复；这不代表已验证重新构建的桌面版本。

## 决策与证据

- 继续由 `SessionMonacoEditorController.applySelectedLines` 负责定位；Markdown
  解析、查看器标签的行号字段和重复点击请求已能传递正确目标，无需定时器、挂载重试循环
  或重复的导航状态。
- 复现使用 6,600 行合成文本、自动换行、0/20/280/500px 初始宽度、随后扩至 500px，
  并在行号请求之后设置语言。修复前，窄布局首次定位失效；后续外部文本更新也可能恢复
  第 1 行光标。同步目标光标并立即定位后，相同的四组用例通过。
- 原有 `lody-session-monaco-selected-line` 及 gutter 类在当前仓库没有样式定义。
  Monaco 已提供跟随主题的行范围高亮，因此直接复用，不另加主题映射或样式表。
- 显式链接导航不会聚焦编辑器，也不修改文件内容。移动光标是有意行为：后续编辑器操作
  从链接指定的行开始。普通手动滚动不会被强制拉回链接目标。

## 验证与限制

运行中的桌面应用已复现首次点击在顶部、第二次到目标行且没有高亮。临时浏览器环境运行
真实 controller 和 React 查看器，使用 Monaco 0.55.1，仅替换无关的宿主集成。验证包含
首次导航、浅色和深色高亮、调整宽度、切换目标、重复导航，以及 controller 在文本更新时
恢复选择的位置。所属浏览器测试套件已增加合成的 `LineAnchors` story 和行为回归测试。
新增用例在隔离环境通过，换回旧 controller 时会因光标停留在第 1 行而失败。
最终隔离验证共通过六个浏览器用例。

独立验证副本安装了锁定版本的依赖和公共子模块，新增回归用例在真实 Storybook 和 UI
组件上通过，全工作区类型检查、类型感知 lint 和格式化也通过。文档检查通过，有原先的
64 个大小警告，没有错误。重新构建桌面版的验收仍未验证。

完整 `pnpm check` 已运行到测试阶段，但在当前环境未全绿。一项未修改的 CLI 测试预期
SSH GitHub 远程地址，而 Lody Git 包装器返回 `lody-github::owner/repo.git`；另有未修改的
CLI 和组件测试超时或未在截止时间内生成卡顿采样。这些失败不属于本次修复范围。

## 相关归属

- [缺陷报告](https://github.com/LodyAI/Lody/issues/1253)
- [文件链接意图](../../../../specs/local-file-link-actions.zh.md)
- [文件界面实现](../../../docs/sessions-file-surfaces.md)
- [此前的文件链接右键菜单决策](../feature/2026-09-17-markdown-file-link-context-menu.zh.md)
- [Controller](../../../../packages/components/src/lib/session-monaco-editor-controller.ts)
- [浏览器回归测试](../../../../packages/components/tests/e2e/code-collab-stories-smoke.spec.ts)
