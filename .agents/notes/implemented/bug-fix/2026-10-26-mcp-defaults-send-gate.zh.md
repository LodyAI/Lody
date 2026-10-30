# 新对话不再等待远端 MCP 默认项

Status: implemented
Translation: current

[English](2026-10-26-mcp-defaults-send-gate.md)

## 摘要

云端和双模式组合下，新对话输入框会显示“正在读取此项目的默认 MCP 服务器…”并阻止发送，
直到工作区目录房间首次完成远端同步。房间缓慢、卡住或离线时，所有新对话都无法发送。
现在只要本地目录快照读取完成，依赖默认项的选择即可发送，与纯本地和 E2EE 组合已有行为一致。
接受的取舍：本地副本尚未收到项目默认项的客户端，可能按较旧或工作区级默认项创建对话。

## 决定

`useSessionMcpSelection` 在本地文档读取后即报告 `ready`；远端追平只更新尚未发送的选择。
本地读取失败仍以错误阻止发送，因为 Spec 禁止把无法读取的默认项当作空选择。
已有对话和显式选择从未受此限制。

原本的本地读取校验防止静默写入 `[]`，但不足以支持一次存储失败后永久阻止输入框。
现在有使用方时，未读目录按有上限的退避重试，所有使用方与手动重试共享一次读取；
最后一个使用方释放时取消待执行的重试。已经读到的快照在远端同步失败时仍可用。
错误提示提供重试和「不使用 MCP 发送」：该显式操作只为本次发送捕获 `[]`，
不编辑项目默认，也不保存草稿覆盖。不会自动重放输入。

本决定部分撤销了 [项目默认 MCP](../architecture/2026-10-09-project-default-mcp.zh.md)
中记录的远端同步门槛；该门槛用于防止全新云端客户端写入 `[]`。我们认为输入框可用性更重要：
发送前选择在输入框“+”菜单中可见且可编辑，而原门槛在离线时没有上限，也无法恢复。
“带超时等待”的方案被否决，因为慢连接下它仍会拖慢每次发送。

## 证据

- [选择 hook](../../../../packages/components/src/hooks/use-session-mcp-selection.ts)
- [选择测试](../../../../packages/components/tests/project-default-mcp.test.tsx)
  覆盖云端/双模式在追平前发送，以及两种内容模式在房间未同步时的行为。
- [room 恢复测试](../../../../packages/components/tests/workspace-catalog-room.test.ts)
- [单次发送关闭测试](../../../../packages/components/tests/session-chat-input-submission.test.tsx)
- [Spec](../../../../specs/project-default-mcp.zh.md)
