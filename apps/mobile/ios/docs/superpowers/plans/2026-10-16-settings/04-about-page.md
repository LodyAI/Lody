# SET-04 建立关于页并整理版本与许可入口

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                            |
| -------- | ----------------------------------------------- |
| 阶段     | 第一阶段                                        |
| 优先级   | P0                                              |
| 状态     | 已完成                                          |
| 依赖     | [SET-01](./01-section-contract-and-baseline.md) |
| 当前授权 | 2026-10-17 已授权首页重排及必要二级页接入       |

## 目标

让首页“关于”成为明确的导航入口，将版本、构建号和开源许可归入二级页面。

## 当前依据

首页“关于”分组目前包含不可点击的版本行、诊断入口和许可入口；许可列表及详情页已经存在。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/screens/SettingsScreen.tsx`
- `apps/mobile/src/screens/LicensesScreen.tsx`
- `apps/mobile/src/screens/LicenseDetailScreen.tsx`
- `apps/mobile/verification/ui/licenses.py`
- `apps/mobile/src/screens/DiagnosticsScreen.tsx`

## 工作内容

- [x] 新增计划文件 apps/mobile/src/screens/AboutScreen.tsx，使用 NativeGroupedList 与现有页面契约。
- [x] 展示真实版本和构建号；保留开源许可列表与详情的原有内容和导航。
- [x] 诊断保留在首页“其他”分组，由 SET-05 接入；不藏进版本说明。
- [x] 核对迁移后不再需要的首页 import／处理器，只删除本任务可以归属的残留。
- [x] 同步 en／zh-Hans 和许可验收入口。

## 验收标准

- [x] 从首页进入关于，再进入许可详情，返回路径正确。
- [x] 版本和构建号来自当前构建配置，缺失时沿用明确的现有兜底。
- [x] 未登录可访问关于、许可与诊断；没有无效箭头或假操作行。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不新增更新器、营销页、未经核实的支持链接；报告 Bug 由 SET-18 负责。

## 关联任务

[SET-05](./05-home-sections-and-connection.md) · [SET-06](./06-phase-one-acceptance.md) · [SET-18](./18-bug-reporting.md)

## 实施记录

- 开始日期：2026-10-17。
- 协议／范围结论：只迁移已有设置与入口，保留 provider、存储键、原生导航和服务边界。
- 验证与证据：pnpm check、pnpm bundle 已通过；设置范围的英文浅深色 UI 检查已通过，证据位于 `.artifacts/settings-reorder/`。
- 未解决问题：不运行聊天、模型、Share Extension 或目标页面的完整业务流程；本轮只验实际迁移影响。

- 实现：`AboutScreen` 展示配置中的版本／构建号并进入原许可页；首页诊断保留在“其他”组。现有 `licenses.py` 同步增加关于页这一层导航。

- 完成日期：2026-10-17。`settings-baseline` 英文浅色／深色各覆盖六个状态及本次迁移入口，检查耗时分别为 257.65 秒／256.33 秒；截图与导航视频在 `.artifacts/settings-reorder/ui/`。
