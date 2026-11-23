# 关联后台 Bash 任务与真实命令

Status: implemented
Translation: current
PR: [#1515](https://github.com/LodyAI/Lody/pull/1515)

[English](2026-10-12-background-bash-command.md)

## 摘要

Claude 后台任务直接显示内部类型 `local_bash`，详情只展示 SDK 描述，而描述不一定是真实命令。
面板现在将这类任务标为 Bash，并从同一轮次保留的发起工具调用中解析命令。
详情将任务说明与命令分开展示；缺少工具证据时只展示普通说明。
此修改仅涉及展示，不增加协议、日志读取器或持久化任务字段。

## 决策

Core 元数据读取器已将 `parentToolCallId` 映射为 `toolUseId`。
`collectSubagentTasks` 用此精确 ID 关联 execute 工具的 `toolCallId`，
读取其结构化 `terminal_command`，复用会话命令格式化函数。
同时识别 Core 的 `actor: local_bash` 和旧数据的 `taskType: local_bash`。
收集逻辑支持两种条目顺序，并随轮次更新重新计算；不扫描其他轮次，也不根据描述猜测命令。

UI 派生出的命令使用单独的高亮、可复制区域。
这扩展了[共享对话框渲染](../simplification/2026-10-04-subagent-dialog-rendering.zh.md)，
保留现有任务状态和取消行为。本次范围仅为命令关联；后台输出需要独立的传输与读取链路。

## 验证

现有面板测试覆盖 Core 与旧数据关联、无关工具 ID、缺少命令、
对话框打开后工具调用到达，以及任务说明的保留。
19 项面板测试和组件包类型检查均通过，局部格式与 lint 检查通过（lint 保留一条既有测试辅助函数顺序警告）。
文档检查报告六处指向未初始化 Kimi/Pi 子模块的链接，本次修改文档没有错误。
根目录 `pnpm format` 通过。`pnpm check` 的类型检查和类型感知 lint 通过，
随后在未修改的 CLI 递归 SSH 子模块测试中遇到凭据辅助程序 `context_unreadable` 错误
（4,058 项 CLI 测试通过），剩余阶段未完成。未发送真实 Claude 提示词，也未执行原生应用视觉检查。
