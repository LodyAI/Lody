# Agent Role 创建与更新提案

Status: implemented
Translation: current

[English](2026-10-17-agent-role-proposals.md)

## 摘要

Agent 之前只能读取 Role，更新已审阅的指令仍需手动复制到设置。现在 MCP 和 CLI
都可在会话中提出创建或文本更新，由用户点击卡片的保存按钮后应用。两种入口共享
有界 schema 与现有目录写入逻辑；多设备并发保留现有覆盖行为，不引入分布式版本
协调。已经接受的会话 Operation 继续使用冻结配置。

## 决策

[Issue #1624](https://github.com/LodyAI/Lody/issues/1624) 是此功能的来源。采用的范围为
MCP、CLI 同时支持创建与更新，用户确认，以及简单的后写覆盖。它扩展了
[CLI Role 选择器](2026-10-07-cli-session-create-agent-role.zh.md)，不改变派发或
[Role 描述](2026-09-28-agent-role-description.zh.md) 的约定。未增加直接写入 API 或多设备锁。

```text
MCP / CLI -> 活跃会话工具 -> 持久提案通知
用户保存 -> 最新 Role + 文本补丁 -> 现有目录写入器
         -> 已保存的通知回执
```

创建要求明确指定机器与配置，默认私有并使用 Agent 默认配置，生成的 Role id
保存在卡片中。更新要求管理权限，仅允许名称、描述和默认指令。省略字段保持不变，
可选字段的空字符串表示清空。保存时重新检查请求用户、Role 存在性、所有权及提及
名称唯一性。有效修改才增加 revision，不因版本不同而拒绝并发修改。

卡片保存原始有界请求与修改前的文本。重复 request id 返回已有结果，输入不同则
拒绝。重复确认创建时保留同 id 已有的 Role。目录已持久化但通知回执失败时可以重试；
相同更新不再次增加版本。如果期间出现新编辑，重试可能覆盖它，符合接受的并发取舍。
CLI 提案需要活跃会话，不会静默绕过确认。
所有可写字段均支持直接传参：name、description、prompt-prefix，以及创建时的
machine-id 和 agent-config-id。字段参数与 JSON --file 互斥，避免隐式覆盖顺序。
两种输入复用同一 schema 与工具路由；省略字段保持不变，可选文本传空字符串表示清空。
命令测试覆盖完整参数、清空、字段省略、必填字段缺失以及混用输入被拒绝。

## 责任与验证

现有 Session 工具注册器负责校验与路由，daemon 负责本地历史；renderer 写入目录
和确认回执。本功能没有新增后台任务或生命周期资源。Effect feature/fix 评估保留
现有 Promise 会话/文档边界，因为迁移需要扩展到尚未完成的上游文档编排。CLI 本地
IPC 在命令入口使用现有原生 Effect 客户端。

行为测试覆盖字段保留、删除/权限/重名失败、有界输入、真实 Loro 历史中的重试回执，
以及卡片保存、忽略和失败重试。整仓类型检查、lint、Effect lint、i18n 与架构边界检查通过。
全量 CI 测试遇到现有 Git transport fixture 继承当前会话 Git 包装器的环境问题；
仅在测试进程清除 Git/SSH 环境变量与会话 shim 的 PATH 条目后，该文件 24 项测试全部通过。
确认卡片有组件测试和 Storybook 状态；当前环境没有可用的浏览器控制入口，未完成视觉检查。
实现与命令示例见[工具指南](../../../../apps/cli/src/mcp/README.md#agent-role-proposals)。

## 消融验证

逐项删除候选逻辑并运行行为测试后，移除了提案服务中重复的命令解析和角色权限预检。
MCP/daemon 注册器仍校验输入；发布前和用户保存时仍通过共享应用函数检查权限、删除及名称冲突。
更新直接保留命令里的 Role id，避免给不存在的角色生成新 id。新增真实 Loro 历史测试，
验证合法更新产生卡片，而不存在或无权管理的角色不产生历史记录。

- 删除服务重复解析：CLI 提案、命令和 MCP 服务测试 74 项通过。
- 删除重复权限预检：提案与命令测试 24 项通过。
- 再删除共享权限检查：新增历史测试失败；恢复该检查。
- 删除创建重试保护：1 项测试失败；删除无变化更新保护：2 项测试失败。两者均已恢复，
  分别避免重试覆盖后来编辑的角色，以及无变化更新仍增加版本。

消融结果只支持上述局部简化，不代表未覆盖路径已得到证明。

CLI 创建/更新在本地与云版均复用 daemon 的 `session/call-tool`，符合 #1628 的副本归属；命令测试覆盖云版本机路由和范围校验。

PR 前基于 main `2e14ab065` 重新验证：CLI 全套 4309 通过、4 跳过，组件全套 5406 通过。
`pnpm check` 的类型、lint 与 Effect lint 通过，但全量测试在未修改的 e2ee-core 包失败：
mailbox WAL snapshot worker watchdog 超时，以及 receive queued-original 跨进程测试
`sign-failed`。后者单独复测仍失败（13 通过、1 失败）；剩余包未完成。检查进程排除
继承的 Git/SSH 会话包装器环境，因此 CLI Git transport 测试本次通过。
