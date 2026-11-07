# SET-05 重排 Settings 首页并归位连接状态

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段     | 第一阶段                                                                                                                                             |
| 优先级   | P0                                                                                                                                                   |
| 状态     | 已完成                                                                                                                                               |
| 依赖     | [SET-01](./01-section-contract-and-baseline.md)、[SET-02](./02-preferences-page.md)、[SET-03](./03-appearance-page.md)、[SET-04](./04-about-page.md) |
| 当前授权 | 2026-10-17 已授权首页重排及必要二级页接入                                                                                                            |

## 目标

落地统一的首页入口层级，收敛零散 section，同时保留现有账户、内容管理和连接恢复能力。

## 当前依据

首页通过两次 splice 将工作区和会话插到账户后，具体外观与聊天选项又各成分组；连接状态单独成组。远程页实际依赖当前 selected workspace，而首页目前仅按是否登录显示入口。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/screens/SettingsScreen.tsx`
- `apps/mobile/src/screens/AccountScreen.tsx`
- `apps/mobile/src/screens/ArchivedSessionsScreen.tsx`
- `apps/mobile/src/screens/ProjectHistoryScreen.tsx`
- `apps/mobile/src/cloud/catalog/CatalogProvider.tsx`
- `apps/mobile/src/cloud/catalog/connection.ts`
- `apps/mobile/modules/lody-kit/ios/List/LodyGroupedList.swift`
- `apps/mobile/verification/ui/home.py`
- `apps/mobile/verification/ui/project-history-entry.py`

## 工作内容

- [x] 按总计划顺序显式构造 sections；账户卡片不显示重复标题，个人组只放偏好与外观。
- [x] 工作区组显示当前工作区名称，保留机器、Agents、MCP 三个入口；无工作区时显示明确说明，不允许点开后立即空白退出。
- [x] 正常连接／同步状态放工作区 footer；离线增加明确可点击的重新同步行，保留已缓存数据与最后同步时间语义。
- [x] 会话与记录保留项目历史和归档入口，并与当前工作区可见条件一致。
- [x] 其他组保留关于和诊断；Debug 只按现有 **DEV**／uiVerify 条件出现。
- [x] 按导航性质保留 row ID 或同步所有引用；保持 push 返回、交互取消及 diffable snapshot 的选择态规则。
- [x] 删除迁移完成后的重复行和首页专属处理器，不扩大到共享列表重构。

## 验收标准

- [x] 未登录、已登录无工作区、工作区正常／同步／离线／缓存状态有明确显示；名称与入口条件取当前 selected workspace。
- [x] 所有原有功能仍可到达，偏好和外观不再在首页重复出现。
- [x] 离线重新同步实际触发既有 refresh，进入同步状态后重试行消失；保留既有错误恢复，不把机器数量解释成在线机器数量。
- [x] 账户退出后不显示上一账户的工作区内容；未登录欢迎卡片不伪装成可执行登录入口。
- [x] 返回与取消交互返回的选择态正确，滚动边缘与透明导航栏沿用原生实现。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不改变登录机制、不新增工作区切换器、不新增未完成模块的占位行。需要真正修改列表共用能力时先证明现有 API 无法表达。

## 关联任务

[SET-06](./06-phase-one-acceptance.md) · [SET-07](./07-workspace-general.md) · [SET-08](./08-machine-management.md) · [SET-09](./09-agent-management.md) · [SET-10](./10-mcp-management.md)

## 实施记录

- 开始日期：2026-10-17。
- 协议／范围结论：只迁移已有设置与入口，保留 provider、存储键、原生导航和服务边界。
- 验证与证据：pnpm check、pnpm bundle 已通过；设置范围的英文浅深色 UI 检查已通过，证据位于 `.artifacts/settings-reorder/`。
- 未解决问题：不运行聊天、模型、Share Extension 或目标页面的完整业务流程；本轮只验实际迁移影响。

- 实现：`SettingsScreen` 按账户、个人、工作区、会话与记录、其他、开发顺序构造 section。账户卡片取消重复标题；首页移除外观／通知／聊天具体选项及许可直达行。
- 工作区入口与会话记录同时要求登录且存在当前工作区。无工作区只显示说明；正常与同步状态使用工作区 footer，离线提供真实 refresh 动作，并在存在同步时间时提示缓存。
- `settings-baseline` 复用既有六个离线上下文，直接检查本次新排版、迁移入口、原生返回及缓存重试；不冻结内部 section 数组。
- 本轮未操作实际工作区切换器、云端登录／退出或后端故障重连；账户／工作区可见条件以离线边界和源码核对证明。对应服务与选择机制没有改动。

- 完成日期：2026-10-17。`settings-baseline` 英文浅色／深色各覆盖六个状态及本次迁移入口，检查耗时分别为 257.65 秒／256.33 秒；截图与导航视频在 `.artifacts/settings-reorder/ui/`。
