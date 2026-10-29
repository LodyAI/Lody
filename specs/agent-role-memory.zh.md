# Agent Role 记忆 Provider

Status: draft
Translation: current

[English](agent-role-memory.md)

## 场景与职责

用户在设置 → 记忆中选择机器，管理 Lody 保存的记忆关联。“添加记忆体”打开与
Agent Config 一致的双栏编辑器，左侧选择 Provider，右侧提供创建和导入两个 Tab。
创建会在 Provider 中登记身份并自动关联；导入页展示设备上的身份，通过 checkbox 多选
批量导入，并复制每个所选身份的名称和描述。已经关联的身份仍显示，但不能重复选择。

记忆内容由 Provider 管理。Lody 在所选机器的 Loro/Flock 文档中以
`['memory', providerId, memoryId]` 保存机器 ID、名称和可选描述。写入使用现有
workspace writer，本地持久化完成即成功，远程上传为尽力而为。稳定键保证重复关联
不会覆盖已自定义的元数据。编辑通过适配器修改 Provider 档案，并将返回的名称和描述同步到 Lody；删除仅移除关联，不删除 Provider
数据。登记成功但本地保存失败时，可以重试关联而不重复登记。不会自动导入已有身份。

卡片最左侧显示垂直居中的灰度 Provider logo，右侧显示名称及第二行描述；悬停或键盘聚焦显示编辑与
删除操作。页面右上角提供添加和刷新。只有成功取得的 Provider 列表缺少已关联身份时
才显示警告；离线、未运行和探测失败不证明身份被删除。进入页面、重新聚焦及页面可见
期间每 30 秒探测，已有请求进行中时跳过自动刷新。记忆设置页和 Role 编辑器的记忆栏在探测
期间保留已有列表，不展示 loading；探测完成后的异常仍以内联状态显示。

Role 编辑器顶部提供“配置”和“团队”两个 Tab，共享草稿及保存操作。“共享到工作区”仅放在团队 Tab。
记忆属于具体机器，因此作为配置 Tab 中每个机器 Tab 的一栏（见[多机器配置](agent-role-machine-targets.zh.md)），
复用设置页的 logo、名称与描述卡片，列出该机器的导入记录，点击卡片
即可选择关联，也可取消关联。每个机器配置的运行配置与
turn 输入仍只保存 `{ providerId, memoryId }`；添加机器时，只有该机器有相同关联才会沿用记忆体。
删除目录关联不会改写现有 Role 或已接受的 turn。Role 取消关联只影响未来的 turn，
已接受的 turn 与 Operation 保持冻结配置。记忆内容和凭证均不进入目录。

## Provider 边界

Daemon 负责检测安装与运行状态、列出和创建身份，以及将身份映射到 ACP 进程环境变量。
Provider 向界面提供名称、安装链接和支持的创建字段。调用方不能通过记忆 RPC 传入命令
或任意环境变量字典。

首个适配器为 Nowledge Mem。执行 `nmem status -j`；找不到可执行文件时，在该机器的
记忆设置页（以及 Role 记忆选择区）内显示说明文案，并提供
`https://mem.nowledge.co/en`；命令成功退出且顶层状态为 `ok` 或 `healthy` 时视为就绪，
其他状态值提示启动 Mem 后刷新。进入记忆设置
仍会自动探测当前机器。nmem 未安装或未运行不得弹出对话框。就绪后执行
`nmem agents list -j`，读取 `agentProfiles`。创建执行 `nmem agents enroll <id> -j`，
名称必填，描述、角色和默认 Space 可选，表单复用现有设置编辑对话框。Enrollment
只创建新身份，已有 ID 保持原档案，最终以 Provider 返回的列表为准。

设置页复用 Agents 的机器选择：桌面窗格在可见机器多于一台时使用 line tabs，窗格外
使用 pills，纯本地平台不显示远程机器选择。已保存的关联使用与 Agents 一致的目录卡片。
Role 编辑器的记忆栏复用关联卡片、状态文案与安装链接。离线机器以及未声明 `memoryProviders` v1 的
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

记忆编辑器在整个窗口居中，桌面尺寸为紧凑的 900 × 600 px，并限制在 96dvw × 92dvh 内。
创建表单要求名称非空，并将名称和 Agent ID 按顺序放在同一行，未手动修改 ID 时随名称转为全小写。
Space 暂时隐藏，默认不传值；Nowledge 登记固定传 source-app 为 lody.ai。
关联列表始终只显示名称和描述，选中后不展开详情，也不再请求额外的 Provider 档案字段。

Provider 侧栏使用与 Agent Config 一致的平面选中列表行，只有一个 Provider 时也相同。
设置中保存关联记录的文案为“导入”，Role 绑定记忆体仍称“关联”。

机器 Tab 显示在线状态圆点，默认选中本机。Nowledge 编辑表单与创建一致，ID 只读，
名称、描述和角色可编辑，通过 nmem agents set 修改。清空可编辑字段会显式传递空值，
隐藏的 Space 与来源字段保持不变。Provider 修改失败时不保存本地元数据。

可访问的 Role 目录加载完成后，没有被其中任何 Role 关联的记忆体会在编辑和删除前显示
“去关联角色”。入口打开完整角色页，定位到第一个在该机器上运行的角色并以该机器 Tab 打开编辑，
新建角色预选该机器，不自动修改 Role 或选择记忆体。角色页不提供机器 Tab 或机器筛选，校验使用完整可访问角色目录。

已关联的记忆体显示“已关联：”及可访问的关联角色 emoji 头像。桌面悬停或聚焦显示
角色名称，移动端点击显示名称浮层。关联按 Role 任一机器配置的机器、Provider 和记忆 ID 精确匹配，并随
角色目录更新。

## 内置个人记忆提案（Lody Memory）

上面的机器作用域关联和环境映射继续描述 Nowledge 等外部 Provider，现归入“集成 Provider”。
拟新增的 Lody Memory Provider 使用 `@lody/memory`，位于机器标签页之上，因为它属于个人而非机器。
同一工作区内的可信用户创建具名记忆体，名称和描述写入该记忆体 `MEMORY.md` 的 front matter。
Role 通过 `{providerId: "lody", memoryId}` 关联一个记忆体，多个 Role 可共用；
机器、模型和 Role 名称不参与分区。
首版仅支持个人模式，不把共享归属作为隐式回退，也不自动转换个人内容。

Loro 是唯一权威来源。记忆使用根级 `meta` 和 `documents` Map：`meta` 保存格式版本及身份；
相对 Markdown 路径直接作为文档 Map 的 key，文档、正文及来源采用 mergeable Map/Text 容器。
同路径并发创建对应同一文档，无需额外唯一性索引。路径就是身份：
改名迁移可见内容与来源到新路径，不保留旧 CRDT 容器身份，也不隐式覆盖已存在的目标。
`MEMORY.md` 是简短入口，Wiki 链接仅在本记忆中解析。
描述改善导航和排序，但不排除仅正文命中的结果。
删除移除父键；读取和编辑不恢复缺失路径，显式创建允许复用已删除路径及其保留历史。
不维护额外业务墓碑。

宿主授权当前执行并传入已绑定 Doc，模型输入不能选择其他个人主体、Role 或记忆，且只打开所有者目录中列出的记忆体。
Renderer/CLI 保留现有写入所有权，本地持久化仍由宿主负责，内存 commit 不等于保存回执。
个人资源授权和现有 E2EE 适配器保护完整数据边界前，生产同步保持不可用，
不得回退到明文或另建密码方案。新增 Provider 不迁移或修改 Nowledge 数据。

目前已实现[包内文档服务](../packages/memory/README.md)，包含增删改查、分页读取、搜索、来源及启动上下文组装；
已接入本地 Agent 提示注入、MCP 工具、设置页管理、Role 选择器及独立 SQLite/IndexedDB 持久化。
Renderer 自行编辑，通过现有本地数据通道传给 CLI，不使用代写 RPC；生产跨设备同步仍关闭。
停用或删除 Role 会撤销后续 Agent 访问，但不销毁内容；删除记忆体会将其移出目录并移除其文档。
不抹除已披露的对话上下文。关联要求本设备 daemon 声明 `builtinMemory: 1`；
生产同步落地前，“不绑定机器”指不按机器分区，而非在机器间复制。普通清理缓存保留个人记忆，显式完整重置可删除本地副本。
归属与存储合同继续保持 draft，测试结果不代表人工批准。
