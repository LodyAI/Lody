# 项目默认 MCP 选择

Status: draft
Translation: current

[English](project-default-mcp.md)

## 场景

项目的「默认 MCP」Tab 列出当前工作区 MCP，每项一个开关。该项目的新对话预选
这些 MCP，用户发送前可以调整。Worktree 和分支共用项目设置。UI、CLI、MCP 创建
属于同一功能范围；分阶段交付时，不能在所有入口完成前宣称完整支持。

## 归属与选择

工作区 Flock 文档保存 MCP 目录和每个项目可选的一行 `projectMcpDefault`，值只有
`{ ids: McpServerId[] }`。无行时继承工作区 `enabledByDefault`；有行时整组替换，
`[]` 表示全关。第一次切换开关时，保存当前有效列表加本次修改。
项目自定义后，不自动加入新增的全局默认 MCP。同一项目并发编辑遵循 Flock 的
后写顺序；明确接受整组冲突，不增加逐个 MCP 的继承状态。

本地身份由机器 id 与项目 id 组成；GitHub 身份为统一大小写后的仓库名称。
不包含分支或 Worktree 路径。有 GitHub remote 的本地项目仍与 GitHub 项目隔离。
工作区由文档限定；机器字段只标识本地项目，不是 MCP 机器绑定。连接配置只属于目录。

写入优先级：显式 ids（含 `[]`），其次是续聊目标对话已有选择，新建时才解析项目/
工作区默认。未记录选择的旧对话保持空选择，不因打开而追溯加入默认项。
新委派对话使用目标项目，不继承调用者选择。Role 不存 MCP ids。Fork、编辑重发
保持既有来源选择行为。

## 接受与执行

写入轮次或接受 Operation 前，从就绪的工作区快照解析默认项。读取失败应报错，
不能当成空列表。显式 ids 无需解析默认。结果写进现有每轮
`inputConfig.mcpServerIds`；Operation 复用现有逐目标 dispatch 配置，不增加第二套
冻结机制。重试/恢复使用已冻结 ids，ACP 启动不重新应用默认。旧 Operation 未捕获
选择时，恢复保持空选择。只冻结 ids；连接和运行能力仍在启动时解析。
派生默认过滤已删除 ids；显式/历史 ids 保留既有运行时诊断，不能按名称重新绑定。

CLI 创建和续聊支持 `--mcp-server-ids <json>`，包括 `[]`。MCP 单项/批量创建和
续聊支持可选 `mcpServerIds`：续聊省略时沿用目标选择，新建省略时解析默认。
这也让工作区默认开始应用于这些新建入口。

## UI 与持久化

「默认 MCP」位于「技能」之后。显示名称、描述、开关、缺连接警示、加载、保存失败
与只读状态。空目录提供 MCP 管理入口，说明仅预选新对话且可在输入框调整。
首版不包含搜索、计数或逐项继承控件。

草稿覆盖在工作区/项目切换时立即隔离。本地快照读取前禁止依赖默认项的发送；
远端同步追平不阻塞发送。
附件延迟发送保留点击时的选择。开关开启不代表已连接或成功加载。

项目写入验证管理权限、工作区范围及输入；本地持久化即成功，后续上传失败不能
回滚或报编辑失败。本地桌面通过现有平台/repo 端口访问，不能触发产品云请求。
仅选择 Flock 并不能证明这个保证。

## 兼容与验证

已有 dispatch 字段可直接复用，不新增机器协议能力。旧客户端忽略新偏好数据族，
输入框保持旧行为。定向验证未知行保留和显式 ids dispatch，不引入大版本矩阵。

验收覆盖无行/空/自定义选择、删除 ids、项目/机器及工作区隔离、加载失败、授权、
保存失败、UI/CLI/MCP 创建及续聊、显式关闭、已接受 Operation 重试、附件延迟发送、
本地零产品云请求。共享契约应明确目录、项目默认、轮次选择三层持久职责。

## 证据与实施状态

- [选择与身份](../packages/shared/src/workspace-mcp.ts)
- [Flock 行](../packages/shared/src/workspace-flock.ts)
- [CLI 轮次写入](../apps/cli/src/commands/session.ts)
- [MCP 写入](../apps/cli/src/mcp/lody-mcp-server.ts)
- [决策及剩余工作](../.agents/notes/implemented/architecture/2026-10-09-project-default-mcp.zh.md)

共享存储、CLI/MCP 写入、桌面项目 Tab 和输入框接入已实现。行为测试覆盖上述边界；
尚未走查打包 Electron 应用。本文等待人工审阅，保持 draft。
