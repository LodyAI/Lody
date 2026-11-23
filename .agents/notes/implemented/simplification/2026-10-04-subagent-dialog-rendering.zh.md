# 子代理弹窗共享会话渲染

Status: implemented
Translation: current
PR: [#1243](https://github.com/LodyAI/Lody/pull/1243)

[English](2026-10-04-subagent-dialog-rendering.md)

## 摘要

子代理弹窗虽然使用父会话的工具组件，却把所有条目平铺成列表，命令简介另用
普通文本展示，也未传入父会话的文件打开回调。现在弹窗共享会话活动分组、
命令高亮和文件链接，同时独立保存每个任务的折叠状态。任务状态、列表行、
弹窗详情和消息布局分别归属不同模块，各展示区域有相邻的 StyleX 文件。
弹窗仍然只读取已保留的子代理输出，不新增子代理执行控件。

## 决策

`SubagentRunMessageList` 使用 `buildAssistantTurnRenderBlocks`；宿主传入
现有的 Markdown、计划、工具与活动标题渲染器。保留渲染器注入，避免任务面板
反向依赖会话的大型 view 模块。分组初始展示所有步骤，流式更新保留用户的折叠
选择。分组前后的正文保持可见，弹窗行不注册父会话搜索块。

后台命令简介在 `ToolDetailSheet` 中使用 `ToolCommandSection`，共享
[工具详情决策](../feature/2026-09-26-tool-step-detail-sheet.zh.md)引入的 Worker shell
高亮。移除简介独立的纵向高度限制，让弹窗正文统一负责纵向滚动。任务状态与
取消语义继续遵循[子代理 Spec](../../../../specs/subagent-events.zh.md)；
[早期客户端接口决策](2026-09-12-subagent-client-surface.zh.md)仍解释为何没有
无使用者的输出与列表 API。

面板保留原有导入路径。任务状态辅助函数与弹窗行为移至独立模块；面板、详情
和消息布局分别使用相邻的 `.stylex.ts` 文件。会话提供间距 token，UI 文本角色
替代详情中的固定字号。Storybook 使用生产环境的历史渲染器，替代仅展示步骤
标题的普通列表。

父会话与子代理活动行中的思考正文显式使用紧凑 Markdown，与摘要及工具行
共享 subheadline 字号和行高。此前的次级文本类名无法覆盖 Markdown 的内联
正文字号，导致 13px 摘要旁的思考仍为 14px。本次修正该字号不一致，普通回答
正文保持原有阅读字号。

## 验证

四个相关测试套件的 39 个测试通过，覆盖命令面板渲染、活动折叠、实时尾部状态、
任务更新、取消失败及移动端 drawer portal 归属。修改范围内的格式化与 lint
通过。浏览器检查了生产 Storybook 弹窗的桌面展示与 390px 移动 drawer 展示，
包括折叠与唯一正文滚动区域。两个浏览器回归测试确认浅色与深色主题中的思考
正文、活动摘要及工具行实际均为 13px，思考行高为 18px。完整组件类型检查仍在未修改的 Markdown/runtime
模块报告三个依赖版本诊断；修改的源文件已无诊断。初始化 ACP 子模块后，文档与公共边界检查
通过；没有修改 SHA 保护主题。已尝试根目录 `pnpm check`，但 worktree 依赖
不完整：文档预检查缺少 `fumadocs-mdx`，初始化后的 Claude ACP adapter 也缺少
Node 类型与 `@tsconfig/node22` 依赖，完整检查因此未通过。
未执行原生 Electron 或实体设备触摸验证。
