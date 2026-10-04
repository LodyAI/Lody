# Agent Role 记忆 Provider

Status: draft
Translation: current

[English](agent-role-memory.md)

## 场景与职责

用户在设置 → 记忆中选择机器，查看记忆身份，按需创建。展开 Role 编辑器中的记忆区域后，
可以关联该 Role 目标机器上的身份。取消关联影响之后提交的 turn，已经接受的 turn 与
Operation 保持冻结的配置。

记忆数据归 Provider 管理。Lody 只在 Role 运行配置和 turn 输入中保存
`{ providerId, memoryId }`，机器沿用 Role 的精确绑定。该引用不是凭证，工作区可见性
不会使记忆内容进入工作区目录。编辑器中更改 Role 的机器会清空记忆关联。

## Provider 边界

Daemon 负责检测安装与运行状态、列出和创建身份，以及将身份映射到 ACP 进程环境变量。
Provider 向界面提供名称、安装链接和支持的创建字段。调用方不能通过记忆 RPC 传入命令
或任意环境变量字典。

首个适配器为 Nowledge Mem。执行 `nmem status -j`；找不到可执行文件时，在该机器的
记忆设置页（以及 Role 记忆选择区）内显示说明文案，并提供
`https://mem.nowledge.co/en`；状态不是 `ok` 时提示启动 Mem 后刷新。进入记忆设置
仍会自动探测当前机器。nmem 未安装或未运行不得弹出对话框。就绪后执行
`nmem agents list -j`，读取 `agentProfiles`。创建执行 `nmem agents enroll <id> -j`，
可选填写名称、描述、角色和默认 Space，表单复用现有设置编辑对话框。Enrollment
只创建新身份，已有 ID 保持原档案，最终以 Provider 返回的列表为准。

设置页复用 Agents 的机器选择：桌面窗格在可见机器多于一台时使用 line tabs，窗格外
使用 pills，纯本地平台不显示远程机器选择。当前机器的 Provider 是目录分组，标题栏
包含刷新和创建按钮，空状态也提供创建入口。Role 编辑器的记忆区保持折叠，展开后使用
同一套身份列表、状态文案和安装链接。离线机器以及未声明 `memoryProviders` v1 的
daemon 不会收到记忆 RPC。请求沿用现有本地/远程机器路由，本地失败不回退到远程传输。

## 执行

选择 Role 时将记忆引用冻结到用户 turn 和已接受的创建 Operation。预热匹配也包含此引用。
ACP 启动在环境组装完成后解析适配器，Nowledge Mem 注入 `NMEM_AGENT_ID=<memoryId>`。
在 turn 之间切换身份时，沿用恢复路径重建 ACP 进程，因为运行中进程的环境不能修改。
Fork 和恢复读取冻结的历史配置，不重新查询可变 Role。未知 Provider 明确失败。
其他 Provider、自动安装或配置 Agent 端 Mem 插件不在本次范围内。

## 证据

- [Provider 契约](../packages/shared/src/memory-provider.ts)
- [Daemon 适配器](../apps/cli/src/lib/memory-providers.ts)
- [设置界面](../packages/components/src/components/settings/memory-setting.tsx)
- [进程边界](../apps/cli/src/session/session.ts)
