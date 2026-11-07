# SET-07 接入工作区通用设置

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                           |
| -------- | ---------------------------------------------- |
| 阶段     | 第二阶段                                       |
| 优先级   | P1                                             |
| 状态     | 已完成（名称／图标）                           |
| 依赖     | [SET-05](./05-home-sections-and-connection.md) |
| 当前授权 | 已授权接入；iPad 按用户要求暂缓                |

## 目标

在工作区组补“通用”入口，本轮复用已有名称与图标编辑。生命周期操作后续按需另定范围。

## 当前依据

WorkspaceEditorScreen 已有名称和图标修改，使用 AuthProvider 的更新能力；本轮在 Settings 工作区组顶部接入“通用”，直接复用已有编辑表单。截图中的生命周期操作是否可用，尚未核实。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/screens/WorkspaceEditorScreen.tsx`
- `apps/mobile/src/cloud/auth/AuthProvider.tsx`
- `apps/mobile/src/screens/SettingsScreen.tsx`
- `apps/mobile/verification/ui/home.py`

## 工作内容

- [x] 已追踪 Inbox 工作区菜单和编辑页；设置“通用”直接 present 同一编辑页，沿用 Cancel／Save 表单契约。
- [x] 入口参数取当前选中的工作区，并把 ID、名称、图标作为本次编辑会话参数固定；使用原服务更新共享投影。
- [x] 接口按明确的工作区 ID 写入；新增 403 拒绝检查。当前投影不含角色，权限交由既有服务端契约，失败提示和草稿保留沿用原编辑页。
- [x] 退出／归档／删除暂缓：本仓公共适配器目前只接名称、图标，没有这些操作的调用方；本轮未调查其服务端可用性，不据此声称后端不支持。

## 验收标准

- [x] 改名、图标选择与读回通过局部 UI 检查；权限拒绝通过接口检查，原编辑页的失败提示和草稿保留逻辑未改动。
- [x] 编辑参数固定原始工作区 ID；切换后重新进入通用页读取新工作区。
- [x] 服务端权限拒绝不视作成功；沿用编辑页 catch 提示及草稿保留。没有新增危险生命周期操作。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不会默认把删除工作区列为首版必做项；已有编辑能力可以先交付，不等待生命周期接口。

## 关联任务

[SET-05](./05-home-sections-and-connection.md) · [SET-20](./20-roadmap-closeout.md)

## 实施记录

- 开始日期：2026-10-17。
- 协议／范围结论：名称与图标沿现有 AuthProvider 和官方组织更新／头像上传适配器；生命周期操作暂缓，不新增服务端接口或占位行。
- 验证与证据：pnpm check、pnpm bundle、9 个 cloud 接口行为检查，以及独立 workspace-general 英文浅深色 UI 检查均通过。证据：`.artifacts/settings-set-07/`。
- 未解决问题：当前 Workspace 投影没有成员角色，不推测本地管理员身份；沿用服务端权限拒绝，未新增角色预检接口。

## 实现与验证边界

- `SettingsScreen` 新增 `workspace-general` 行，未登录或没有当前工作区时不显示；标题为“通用”，说明为“名称与图标”。
- 直接复用 `WorkspaceEditorScreen`，该文件和 AuthProvider／接口实现均未改动。图标沿用选择后立即上传的既有语义，名称沿用 Save；表单行属于临时操作，打开时立即取消列表选择。
- 复用既有 HomePreviewProviders，离线检查正式设置入口、系统图标选择、名称保存读回、原有首页同步显示、取消以及切换后新入口目标；不重跑完整 home 用例。
- 接口检查确认显式 `organizationId` 及 403 错误；未真实授权、上传或修改工作区，未新增本地角色判断。
- 本轮不运行 iPad、聊天、模型、Share Extension 或生命周期检查。

- 完成日期：2026-10-17。UI 检查浅色 89.29 秒、深色 86.74 秒；截图与视频：`.artifacts/settings-set-07/ui/`。复用原签名 Debug app，无新增原生代码。交付范围为本文件所列的名称／图标入口与检查，额外本地草稿另行保留。
