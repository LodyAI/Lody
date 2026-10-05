# Agent Role 记忆 Provider

Status: draft
Translation: current

[English](agent-role-memory.md)

## 场景与职责

用户在设置 → 记忆中选择机器，管理 Lody 保存的记忆关联。“添加记忆体”打开与
Agent Config 一致的双栏编辑器，左侧选择 Provider，右侧提供创建和导入两个 Tab。
创建会在 Provider 中登记身份并自动关联；导入页展示设备上的身份，单选后复制名称和
描述。已经关联的身份仍显示，但不能重复选择。

记忆内容由 Provider 管理。Lody 在所选机器的 Loro/Flock 文档中以
`['memory', providerId, memoryId]` 保存机器 ID、名称和可选描述。写入使用现有
workspace writer，本地持久化完成即成功，远程上传为尽力而为。稳定键保证重复关联
不会覆盖已自定义的元数据。编辑通过适配器修改 Provider 档案，并将返回的名称和描述同步到 Lody；删除仅移除关联，不删除 Provider
数据。登记成功但本地保存失败时，可以重试关联而不重复登记。不会自动导入已有身份。

卡片最左侧显示垂直居中的灰度 Provider logo，右侧显示名称及第二行描述；悬停或键盘聚焦显示编辑与
删除操作。页面右上角提供添加和刷新。只有成功取得的 Provider 列表缺少已关联身份时
才显示警告；离线、未运行和探测失败不证明身份被删除。进入页面、重新聚焦及页面可见
期间每 30 秒探测，已有请求进行中时跳过自动刷新。

Role 记忆区保持折叠，展开后列出其精确目标机器上已保存的关联。Role 运行配置与
turn 输入仍只保存 `{ providerId, memoryId }`；切换 Role 的机器会清空该引用。
删除目录关联不会改写现有 Role 或已接受的 turn。Role 取消关联只影响未来的 turn，
已接受的 turn 与 Operation 保持冻结配置。记忆内容和凭证均不进入目录。

## Provider 边界

Daemon 负责检测安装与运行状态、列出和创建身份，以及将身份映射到 ACP 进程环境变量。
Provider 向界面提供名称、安装链接和支持的创建字段。调用方不能通过记忆 RPC 传入命令
或任意环境变量字典。

首个适配器为 Nowledge Mem。执行 `nmem status -j`；找不到可执行文件时，在该机器的
记忆设置页（以及 Role 记忆选择区）内显示说明文案，并提供
`https://mem.nowledge.co/en`；状态不是 `ok` 时提示启动 Mem 后刷新。进入记忆设置
仍会自动探测当前机器。nmem 未安装或未运行不得弹出对话框。就绪后执行
`nmem agents list -j`，读取 `agentProfiles`。创建执行 `nmem agents enroll <id> -j`，
名称必填，描述、角色和默认 Space 可选，表单复用现有设置编辑对话框。Enrollment
只创建新身份，已有 ID 保持原档案，最终以 Provider 返回的列表为准。

设置页复用 Agents 的机器选择：桌面窗格在可见机器多于一台时使用 line tabs，窗格外
使用 pills，纯本地平台不显示远程机器选择。已保存的关联使用与 Agents 一致的目录卡片。
Role 编辑器展开后复用关联卡片、状态文案与安装链接。离线机器以及未声明 `memoryProviders` v1 的
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

记忆编辑器采用 Agent Config 相同的桌面尺寸，并在整个窗口居中。
创建表单要求名称非空，并将名称和 Agent ID 按顺序放在同一行，未手动修改 ID 时随名称转为全小写。
Space 暂时隐藏，默认不传值；Nowledge 登记固定传 source-app 为 lody.ai。
关联列表始终只显示名称和描述，选中后不展开详情，也不再请求额外的 Provider 档案字段。

Provider 侧栏使用与 Agent Config 一致的平面选中列表行，只有一个 Provider 时也相同。
设置中保存关联记录的文案为“导入”，Role 绑定记忆体仍称“关联”。

机器 Tab 显示在线状态圆点，默认选中本机。Nowledge 编辑表单与创建一致，ID 只读，
名称、描述和角色可编辑，通过 nmem agents set 修改。清空可编辑字段会显式传递空值，
隐藏的 Space 与来源字段保持不变。Provider 修改失败时不保存本地元数据。
