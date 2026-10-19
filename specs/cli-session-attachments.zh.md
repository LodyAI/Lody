# CLI 与 MCP 会话输入附件

Status: draft
Translation: current

[English](cli-session-attachments.md)

调用者可以从一台机器携带本地文件，在另一台机器创建或继续对话。接收方 agent
必须获得完整输入；会话中，附件与文本属于同一条用户消息。

## 输入与归属

CLI 的 `session create` 和 `session chat` 接受可重复的 `--attach <path>`。
相对路径基于命令进程的工作目录。`--prompt-file` 仍然读取提示词，不代表附件。
允许只有附件的输入。

单次 MCP `lody_session_create` 和 `lody_session_chat` 接受可选
`attachments: string[]`。路径属于调用会话所在机器和工作目录，不属于目标机器。
路径规范化后的包含关系检查和不跟随符号链接的文件打开，沿用现有 agent 上传权限边界。
附件要求持久化的 `operationId`；旧 wait 适配器和批量工具本次不增加附件支持。

每条输入最多八个附件，每个非空且不超过 100 MiB。拒绝目录。中转上传中，符合现有
图片限制的受支持图片生成 image block；超限图片生成 file block。本地模式沿用
现有 file/resource-link 表示。

## 准备与提交

准备阶段先检查并将全部源文件复制为私有、有大小上限的临时快照，再传输文件。
全部传输成功后，才能写入或激活目标用户消息，不提交部分输入。准备结束后删除快照；
本地批次失败时删除已准备的 blob；遗弃的中转对象沿用已有保留清理周期。

Cloud 命令使用现有鉴权中转上传。本地模式 MCP 将字节复制到同机现有附件库，
不进行云端访问。传输层只返回引用，不写会话历史。消息写入层负责文本、附件顺序、
执行配置、历史和激活。已有的附件落盘和后台回传职责不变。

## 恢复

MCP 接受操作时，在机器本地 Operation 存储中，将附件引用与固定目标 Session/Turn ID
原子保存。规范化命令记录原始源路径，恢复只使用已冻结的附件引用。重试已接受操作
不重读源文件。并发接受保留首先成功的操作引用和目标 ID。

调用方 daemon 必须声明 `sessionInputAttachments: 1` 才能接受带附件的 MCP 操作。
此类操作仍活跃时，不应降级该 daemon。既有纯文本 Operation 的存储形状保持不变。

消息重试比较完整原始内容和规范化输入配置。同一 Turn ID 不得更换附件。
派发提交后，即使传输确认不确定，也不得回滚。

独立 CLI 命令保留现有的一次发送回执语义。重新运行命令属于新发送，不是持久化重试；
需要可恢复提交的脚本应使用 MCP Operation API。

## 证据

- CLI：`apps/cli/src/commands/session.ts`。
- 准备：`apps/cli/src/lib/session-input-attachments.ts`。
- 传输：`apps/cli/src/lib/session-attachment-transfer.ts`。
- 恢复：`apps/cli/src/orchestration/operation-store.ts`。
- 既有草稿行为：[session-files](session-files.zh.md)。
