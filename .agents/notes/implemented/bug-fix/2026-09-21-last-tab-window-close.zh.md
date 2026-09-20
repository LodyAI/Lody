# 最后一个对话标签的快捷键关闭窗口

Status: implemented
Translation: current
PR: [#866](https://github.com/LodyAI/Lody/pull/866)

[English](2026-09-21-last-tab-window-close.md) | 中文

## 摘要

新开的会话窗口只有一个对话标签时，Cmd/Ctrl+W 原先关闭标签并留下草稿，而没有关闭窗口。
关闭目标解析现在在仅剩一个对话标签时交给原生窗口关闭，子会话和草稿同样适用。
有焦点的侧面板标签仍优先关闭，显式点击标签 × 保持既有生命周期行为。
主窗口和辅助窗口采用同一规则。

## 决策与证据

解析函数原先接收却忽略可见对话数量。现在返回明确的窗口目标，SessionDetail 将其交给
已有的窗口关闭回退路径，不执行共享标签状态变更。无需按窗口来源添加分支，也保留了
主窗口隐藏和辅助窗口关闭的原生区别。多个对话标签仍逐个关闭。

此次只修改快捷键路由；[空标签删除决策](2026-09-18-empty-tab-close-exact-delete.zh.md)
仍约束显式标签关闭。产品意图见[桌面多窗口](../../../../specs/desktop-windows.zh.md)。
[既有测试套件](../../../../packages/components/tests/session-tab-close-target.test.ts)
覆盖父会话、子会话、草稿、聚焦及隐藏的侧面板、多标签和空页面。

## 验证限制

改动的三个 TypeScript 文件通过 Oxfmt 格式检查。当前检出没有安装依赖，
`pnpm check`、`pnpm format` 和定向 Vitest 分别被缺少 tsgo、oxfmt、vitest 阻断。
文档检查仍有既有子模块断链。本次未在原生 Electron 窗口中执行交互验证。
