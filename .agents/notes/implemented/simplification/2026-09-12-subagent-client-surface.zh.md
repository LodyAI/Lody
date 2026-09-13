# 将宿主 subagent 客户端收敛到当前消费者

Status: implemented
Translation: current

[English](2026-09-12-subagent-client-surface.md)

## 摘要

Lody 的 AgentClient 暴露了无人调用的 subagent 列表与输出方法。执行服务只需要取消能力，
任务展示则消费历史元数据。删除这些包装方法及其列表 schema 后，能力检查与连接检查直接由
取消路径负责。Provider 侧的 Core 列表/输出契约保持可用且不变。

## 决策与证据

仓库检索未发现 `AgentClient.listSubagents` 或 `AgentClient.getSubagentOutput` 的消费者；
`SessionExecutionService` 调用的是 `cancelSubagent`。被删除的通用分发器只服务于这三个
包装方法，因此其剩余的校验与请求逻辑并入取消路径，不引入替代抽象。既有的持久化任务读取
方与 provider 实现不受影响。

为未来的任务浏览器保留未使用的包装，会在没有现实需求的情况下维持一套宿主 API 与 schema。
这样的浏览器在真正实现时必须补上自己的宿主接线。当前用户不会失去任何操作。既有的取消测试
仍是回归保护；不会仅为这些删除新增测试。

本记录伴随 [Lody PR #605](https://github.com/LodyAI/Lody/pull/605)。
