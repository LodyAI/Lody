# SET-14 补齐工作区项目可见性管理

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                   |
| -------- | -------------------------------------- |
| 阶段     | 第三阶段                               |
| 优先级   | P2                                     |
| 状态     | 已完成（首版）                         |
| 依赖     | [SET-06](./06-phase-one-acceptance.md) |
| 当前授权 | 已授权按 09 → 13 → 14 → 15 → 16 推进   |

## 目标

补齐截图中“管理哪些本地项目对团队可见”的设置能力，避免和项目首页、历史导入混淆。

## 当前依据

已有项目目录、创建／注册本地项目、目录浏览和历史导入路径；runtime/local-projects.ts 包含 local-project/control 与写入保护，本轮已核实独立的团队可见性协议并接入设置，见下方实施记录。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- [packages/cloud-runtime/src/runtime/local-projects.ts](../../../../packages/cloud-runtime/src/runtime/local-projects.ts)
- [packages/cloud-runtime/src/models/catalog.ts](../../../../packages/cloud-runtime/src/models/catalog.ts)
- `apps/mobile/src/screens/ProjectScreen.tsx`
- `apps/mobile/src/screens/ProjectHistoryScreen.tsx`
- `apps/mobile/tests/native/local-projects.test.mjs`
- `apps/mobile/src/screens/SettingsScreen.tsx`

## 工作内容

- [x] 追踪项目注册、机器归属、团队可见性和移除的真实协议，区分隐藏、解除注册与删除磁盘文件。
- [x] 提供按机器辨认的项目管理列表和实际支持的可见性操作；项目历史继续保留独立入口。
- [x] 权限校验在实际写入边界执行；保留不确定 append 结果不重放的现有保护。
- [x] 明确操作对现有会话、项目目录和其他成员的影响，再设计必要确认。

## 验收标准

- [x] 可见性改变能由读回或目录消费侧证实；不只是前端隐藏。
- [x] 非所有者无法管理他人机器项目，工作区切换后不误操作旧 ID。
- [x] 调整可见性不删除本地文件或会话历史；部分失败与未知结果有明确反馈。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不复用“删除项目”来实现隐藏，不因设置管理扩大磁盘删除能力。

## 关联任务

[SET-08](./08-machine-management.md) · [SET-20](./20-roadmap-closeout.md)

## 2026-10-17 协议预查

已在[官方公开客户端契约](https://github.com/LodyAI/Lody/blob/main/packages/cloud-api/src/index.ts)确认 `localProjects:listVisibleLocalProjects` 与 `localProjects:setLocalProjectSharedWithTeam`。可见性属于云端注册记录，使用工作区、机器和本地项目 ID 定位，不是 `local-project/control` 的删除或目录操作。

实施采用注册记录与当前目录按机器／项目 ID 关联；缺少注册记录时，自己机器上的项目按桌面视为“私有”（见下方实施记录）。写入后重新读取真实状态；未完成读回不显示成功，未知写入不自动重放。所有权需在实际云端边界验证，不能只禁用 UI。本仓适配已完成；尚未调用真实云端。

## 实施记录

- 开始日期：2026-10-17。
- 已接入官方注册查询和 `setLocalProjectSharedWithTeam`。按机器／本地项目 ID 关联目录，使用原生选项菜单显示工作区可见／仅自己；缺失注册记录时与桌面一致：自己机器上的项目视为“仅自己”且可改为工作区可见，他人机器上的不显示；尚未读到或机器归属读取失败时显示未知且不可操作（2026-11-10 owner 决定，取代原“缺失记录不能推断为私有”）。
- 原生使用 Keychain 会话核实当前用户，写前重新查所有权，写后重新查目标状态。失败保留上次确认值、停用操作并提供只读刷新；不自动重放写入。
- 不发送机器删除／目录控制命令，不改磁盘或会话历史；原有项目历史入口独立保留。
- 验证：原生行为检查覆盖同 ID 不同机器、非所有者拒绝、未知写入不重放与写后读回失败；页面映射覆盖只读与未知记录。iPhone 英文浅色／深色交互验收通过。
- 未跑项：真实云端可见性修改、其他成员在线消费及 iPad。

- 验收证据通过上方总计划关联，对应本任务的英文浅色／深色截图与录像。
