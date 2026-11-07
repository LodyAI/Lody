# SET-11 补齐 Agent 角色管理入口

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                                     |
| -------- | -------------------------------------------------------- |
| 阶段     | 第三阶段                                                 |
| 优先级   | P2                                                       |
| 状态     | 已完成（首版）                                           |
| 依赖     | [SET-06](./06-phase-one-acceptance.md)                   |
| 当前授权 | 2026-10-18 用户授权调查、实现、验收后单独 commit 并 push |

## 目标

提供工作区 Agent 角色的管理入口，复用已有角色读取和授权规则，并接回实际使用路径。

## 当前依据

runtime/agent-roles.ts 已读取 agentRole，按 private／workspace 可见性及 machine／agent 关联做校验；不能将这条读取路径视为完整管理 API。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- [packages/cloud-runtime/src/runtime/agent-roles.ts](../../../../packages/cloud-runtime/src/runtime/agent-roles.ts)
- [packages/cloud-runtime/src/models/mentions.ts](../../../../packages/cloud-runtime/src/models/mentions.ts)
- `apps/mobile/modules/lody-kit/ios/CreateSession/CreateSessionController.swift`
- `apps/mobile/src/screens/SettingsScreen.tsx`

## 工作内容

- [x] 核实角色 schema、revision 冲突、所有权、可见性及创建／修改／删除的正式写入路径。
- [x] 先列可访问角色及其所属机器／Agent、可见性和只读原因；使用稳定 ID 处理同名角色。
- [x] 仅对已验证的操作提供表单，保留权限和版本冲突处理。
- [x] 追踪新会话、续聊、@role 等消费者，补齐 v2 多机器引用和实际消息配置检查；远程 daemon 执行按下文划定验证边界。

## 验收标准

- [x] 客户端不展示其他用户的私有角色，工作区角色可见性符合规则；不存在的机器／Agent 不形成可执行角色。
- [x] 冲突、无权限和写入结果不明不被当成成功；不重复写入。
- [x] 实际消费侧使用角色 ID 并读取最新授权内容，不让 UI 注入未经验证的角色指令。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不为管理页重建一份 RN live replica；如触及共享新会话表单，执行 create-parity 前后对照及各宿主检查。

## 关联任务

[SET-09](./09-agent-management.md) · [SET-13](./13-prompt-shortcuts.md) · [SET-20](./20-roadmap-closeout.md)

## 实施记录

- 开始日期：2026-10-18。
- 协议／范围结论：见下文。
- 验证与证据：52 项相关行为检查、31 项 UI runner 检查、`pnpm check`、`pnpm bundle`、正常签名 Release 模拟器构建通过；三类 iPhone 英文浅色／深色场景 6/6 通过。

## 官方协议与权限

本轮通过 GitHub API 核对官方 `LodyAI/Lody` 的 `a15cdae4301d541eacbafdc83f08d22a50f56777`，不使用另一个 checkout 的代码作为 App 依赖。

- [agent-role.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/shared/src/agent-role.ts)：单目标存为 v1 的 `machineId / agentConfigId / runConfig`；多目标存为 v2 的 `targets`，每机器一个目标，没有自动回退。公共字段含名称、说明、指令、可见性、所有者、revision 和时间戳。有效编辑递增 revision，未改变内容不产生新版本。
- [workspace-flock.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/shared/src/workspace-flock.ts)：工作区 `<workspace>:wf:workspace` 的 `['agentRole', id]` 行 set／delete。iOS 沿既有 Streams grant 和大端长度帧写入，没有新增私有 Cloud CRUD endpoint。
- [use-workspace-agent-roles.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/components/src/hooks/use-workspace-agent-roles.ts)：可信客户端只展示自己的 private 角色和 workspace 角色；仅所有者可以编辑、分享、取消分享或删除。工作区写入授权仍由 Streams grant 执行。行级所有权属于官方可信客户端约定，不是服务端 CAS／行级 ACL。
- `private` 不提供存储机密性：角色仍复制在工作区 Flock。iOS 在 native-owned runtime 中过滤后才投影给 RN，界面明确提醒不得存放秘密；不会把机器 env、连接凭据、原始 runConfig 或未知字段投影到表单。
- [agent-role-form.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/components/src/lib/agent-role-form.ts)：名称对应的 mention slug 要在当前用户可见角色及目标别名之间唯一，大小写保留。同名历史行仍以稳定 ID 定位；看不到的其他用户私有角色不参与重名检查。

## 实际生效链路

[mention-agent-role-source.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/components/src/components/mentions/mention-agent-role-source.ts) 和 [agent-role-create.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/apps/cli/src/lib/agent-role-create.ts) 确认：引用是请求当前 Agent 通过 Lody MCP 创建会话，携带 role ID；多机器角色还携带 `agentRoleMachineId`，不会把表单指令直接注入当前 turn。daemon 重新读取目录、确定目标并组合 prompt prefix／运行配置，接受的创建 Operation 冻结角色 revision 和 snapshot。

```text
┌──────────────────────────────────────┐
│ 设置：创建／修改公共字段／确认删除    │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ 工作区 Flock：agentRole v1／v2        │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ 发送前重读：可见性与机器／Agent 绑定  │
│ 多目标引用明确 role ID + machine ID  │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ history／队列持久化，再发机器 RPC    │
│ 指令只请求通过角色创建，不改当前角色 │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ Agent 调用 Lody MCP；daemon 重读角色 │
│ 接受时冻结 revision／snapshot        │
└──────────────────────────────────────┘
```

已有 iOS 缺口是只接受 v1，且文本引用不支持第二个 `@machine`。现已支持 v2 及旧 v1 additionalTargets；不存在的绑定与离线目标不进入引用菜单；在线状态未知时目录标为未完成。引用允许选择任意可达机器，不再受当前项目绑定过滤。发送时被删除或失去可见性的显式引用在 history／mq 写入前失败，不能把旧指令当成有效角色。续聊继续使用已接受 turn 的配置；本轮不新增会话内 Role 选择器，也不把角色公共字段编辑自动应用到正在运行的会话。[use-session-agent-role.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/components/src/hooks/use-session-agent-role.ts) 中的显式重新选择是另一个操作。

## 本轮实现与边界

- 设置增加 Agent 角色入口，生产原生列表与临时表单支持名称、说明、指令和 private／workspace 编辑，原生确认删除；新角色选择现有机器／Agent，使用 Agent 默认配置。
- 已有 v2 目标、别名、模型、模式、记忆绑定、未知字段保持原存储形态；完整目标／运行配置编辑、emoji 和复杂长指令继续由电脑端完成。移动端名称 60 字符、说明 140 字符、指令 32,000 UTF-16 单元；超界角色显示只读。
- 编辑与删除先从服务端 bootstrap，比较显示的 revision、updatedAt 和公共投影，再写一次。无效目标、冲突、权限拒绝不会成为成功；未确认结果持久提示、保留草稿并禁用再次写入，要求关闭后刷新。不存在自动重放。
- 这是客户端乐观检查；bootstrap 与 append 之间的并发仍服从官方 CRDT 规则，不提供服务端原子比较交换。
- Swift 从当前账户注入 user ID，runtime 在异步授权／读取／写入前后检查工作区和账户；账户或工作区变化会立即隐藏并取消旧角色表单及目标选择器；不新增 RN live replica，不把连接秘密或长期凭据送入 JS。
- 机器／Agent 配置存在与否可确认；目录中的配置不证明机器在线、ACP 能力或第三方记忆服务可用，最终执行由 daemon 检查。
- 离线检查使用生产列表／表单和真实 Flock／消息运行时，仅隔离 Streams 与机器 RPC 边界。未登录、未改真实云端角色、未启动真实角色会话或 MCP 工具，iPad／物理设备仍暂缓。

## 验收记录

- 角色管理：读取失败恢复、所有者只读、失效 Agent、多目标展示、重名、冲突保留草稿、分享读回、指定机器创建、删除确认／取消、结果不明禁重放及刷新确认、待定保存时切换账户关闭旧表单、正式设置入口与返回。
- 角色引用：聊天和新会话表单均证明原生插入保留 `role ID + machine ID`，展开后的文本进入发送界面；真实运行时观察 history／mq 与机器派发载荷，失效引用在写入前停止。界面 fixture 不代表远程会话已创建。
- 已逐张审阅 56 张截图，并检查 6 段原始录像的首／中／尾采样；保留原生状态、时间记录、独立推理与原始执行记录。证据目录为 `.artifacts/settings-set-11/`。

- [本轮验收](https://app.lobehub.com/acceptance/772f0d2a-3989-4cd4-b6fd-6bd8c1baed74?r=1)：角色管理、原生引用和权限／消息载荷三项产品行为，保留对应截图、录像与文本证据。
