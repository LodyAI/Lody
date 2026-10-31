# 附件准备期间的输入框来源信息

Status: implemented
Translation: current
PR: [#1160](https://github.com/LodyAI/Lody/pull/1160)

[English](2026-09-30-composer-pending-send-config.md)

## 摘要

附件等待发送时，输入已冻结但尚未写入历史。待发送行保留该输入，并在文档加载期间提供 Role/MCP 来源信息。当前运行配置属于执行端；[配置所有权决定](../architecture/2026-10-31-session-config-ownership.zh.md) 替换了原有待发送模式、模型及选项基线。

## 决定

`useSessionPendingConfig` 订阅某个会话最新冻结条目的身份，而非附件进度。已写入条目在对应 Turn 出现前继续提供来源信息；取消则释放。新观察到的持久 Turn 永久取代较旧本地来源，删除新 Turn 也不能复活旧来源。作用域包含会话和 pending-send store。

逻辑 Turn key 跨等待、历史及队列交接保持一致。私有配置编辑只由自己的准入回执消费，不由来源 fence 消费。冻结整个输入框会阻止下一条草稿编辑；简化标签会丢失 ACP 专用模型和 Role 标签，因此保留现有显示组件。

附件 Spec 负责[发送准入](../../../../specs/session-files.zh.md#61-发送边界)。行为测试使用真实 pending-send store 和受控准备 Promise，覆盖发布延迟、取消、下一条编辑及会话隔离；不代表打包设备或真实 provider 验收。
