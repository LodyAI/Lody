# 将 Automation 提示限制在需要跨轮继续的工作

Status: implemented
Translation: current

[English](2026-11-21-automation-guidance-scope.md)

## 摘要

每轮会话提示、MCP 说明、工具帮助和 Automation skill 都重复推荐 Automation，
让它看起来成了构建和测试的默认方式。产品 owner 反馈使用过多，要求收紧提示。
每轮提示不再推荐它；帮助和 skill 只在命令必须于本轮结束后继续运行、并在退出时
唤醒会话时推荐 `run`。对 agent 选择和消耗的实际影响尚未测量。

## 决定

删除每轮提示中的推荐，MCP 服务器说明只保留 skill 入口。普通命令、构建和测试
在当前轮执行；仅仅耗时较长不足以使用 Automation。条件注册仍仅用于用户要求的未来行为。

这部分撤回了[托管命令决定](../feature/2026-11-16-managed-long-runs.zh.md)中的提示策略。
原记录继续保留进程归属、中断和环境的理由。保留宽泛推荐会把普通工作引向额外的续跑轮次，
因此未采用。托管命令仍然可用：必须跨轮运行的命令仍需要 Host 持有，才能在空闲回收后继续。

## 验证

会话提示测试覆盖生成的提示和可选的 PR 关联说明。MCP skill 测试核对发现清单与实际提供的
内容，并执行条件注册示例。这些检查不能证明 agent 使用 Automation 的实际频率。
