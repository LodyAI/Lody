# SET-03 建立外观页并迁移现有外观选项

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                            |
| -------- | ----------------------------------------------- |
| 阶段     | 第一阶段                                        |
| 优先级   | P0                                              |
| 状态     | 已完成                                          |
| 依赖     | [SET-01](./01-section-contract-and-baseline.md) |
| 当前授权 | 2026-10-17 已授权首页重排及必要二级页接入       |

## 目标

把深色背景、强调色和 App 图标收进外观页，保持系统原生选项与现有持久化行为。

## 当前依据

三个外观选项都在 SettingsScreen 中；自定义颜色使用原生颜色选择器，App 图标使用独立页面。appearance.py 当前从实际 SettingsScreen 检查这些控件，迁移时需要同步入口。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/screens/SettingsScreen.tsx`
- `apps/mobile/src/screens/AppIconScreen.tsx`
- `apps/mobile/src/lib/theme/appearance.tsx`
- `apps/mobile/modules/lody-kit/ios/LodyAppearanceView.swift`
- `apps/mobile/verification/ui/appearance.py`
- `apps/mobile/src/screens/debug/AppIconFailurePreviewScreen.tsx`

## 工作内容

- [x] 先核实现有 appearance 模块的实际扩展名与导出；新增计划文件 apps/mobile/src/screens/AppearanceScreen.tsx。
- [x] 迁移选项、颜色选择器、当前图标读取和前台刷新订阅，复用原生菜单与现有 AppIconScreen。
- [x] 只迁移界面所有权，不改变偏好存储键、默认值和生效范围。
- [x] 更新离线场景与 appearance 检查，先打开外观页，再测试真实菜单和系统颜色选择器。
- [x] 由 SET-05 将首页外观选项替换为单一入口。

## 验收标准

- [x] 首页可进入外观页；原有预设菜单与当前值可用，App 图标入口可进入并返回。
- [x] 自定义颜色选择器、图标读回／失败处理及前台订阅完整迁移；不改变其实现或持久化路径。
- [x] 浅色／深色与系统语义色正确，触控区域至少 44 pt，VoiceOver 能读到当前值。
- [x] 页面卸载后不保留前台订阅，回到首页不出现失效处理器。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

首轮不新增字体、Terminal 显示或语言切换；不重写主题系统，不增加绿色默认强调色。

## 关联任务

[SET-05](./05-home-sections-and-connection.md) · [SET-06](./06-phase-one-acceptance.md) · [SET-19](./19-personal-settings-gap-review.md)

## 实施记录

- 开始日期：2026-10-17。
- 协议／范围结论：只迁移已有设置与入口，保留 provider、存储键、原生导航和服务边界。
- 验证与证据：pnpm check、pnpm bundle 已通过；设置范围的英文浅深色 UI 检查已通过，证据位于 `.artifacts/settings-reorder/`。
- 未解决问题：不运行聊天、模型、Share Extension 或目标页面的完整业务流程；本轮只验实际迁移影响。

- 实现：`AppearanceScreen` 接管首页原有三行、菜单处理和 App 活跃订阅；现有 `appearance.py` 同步增加首页到二级页的跳转。
- 本轮复用既有签名 Debug app，通过 Metro 加载新页面；没有新增原生代码，不重复原生构建或实际切换系统图标。

- 完成日期：2026-10-17。`settings-baseline` 英文浅色／深色各覆盖六个状态及本次迁移入口，检查耗时分别为 257.65 秒／256.33 秒；截图与导航视频在 `.artifacts/settings-reorder/ui/`。
