# SET-06 完成首轮分组整理的集成验收

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段     | 第一阶段                                                                                                                                            |
| 优先级   | P0                                                                                                                                                  |
| 状态     | iPad 暂缓                                                                                                                                           |
| 依赖     | [SET-02](./02-preferences-page.md)、[SET-03](./03-appearance-page.md)、[SET-04](./04-about-page.md)、[SET-05](./05-home-sections-and-connection.md) |
| 当前授权 | iPhone 证据沿用；用户已要求暂缓 iPad                                                                                                                |

## 目标

证明完整 Settings 入口链可用，让第一阶段能够单独交付。

## 当前依据

现有 UI Verify 分散覆盖 home、appearance、notifications、quick-replies、settings、licenses、diagnostics、project-history-entry 和 iPad。远程 settings 场景不能替代首页验收。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/verification/ui/README.md`
- `apps/mobile/verification/ui/run.py`
- `apps/mobile/verification/ui/home.py`
- `apps/mobile/verification/ui/appearance.py`
- `apps/mobile/verification/ui/settings.py`
- `apps/mobile/verification/ui/notifications.py`
- `apps/mobile/verification/ui/licenses.py`
- `apps/mobile/verification/ui/ipad.py`
- `apps/mobile/verification/ui/diagnostics.py`

## 工作内容

- [x] SET-02 至 SET-05 已完成各自局部检查；直接复用现有结果，不重复整套业务回归。
- [x] 已更新 settings-baseline 的入口与六种离线上下文，使用实际生产组件。
- [x] pnpm check、pnpm bundle 和 iPhone 浅深色局部检查已通过；没有新增原生改动，复用既有签名 Debug app。
- [ ] 只补 iPad Settings sheet 的分组显示、滚动和二级页返回；不扩展目标页面完整业务流程。iPhone 的新入口与返回直接复用本轮证据。
- [x] 已留存 iPhone 浅深色截图、导航视频及本轮未跑范围；iPad 补查后追加记录。
- [x] 更新总计划中 SET-01 至 SET-06 的状态、证据和剩余问题；iPad 仍为暂缓。

## 验收标准

- [ ] 英文浅色／深色均通过；未登录与有工作区两个主分支可离线复现。
- [ ] 默认字号下行内容无重叠、触控至少 44 pt、VoiceOver 标题和值合理；截图和视频经人工或工具实际审阅。
- [ ] 共享 collection view 若有修改，覆盖受影响的其他宿主；不将仅截图或仅 bundle 成功视作完成。
- [x] 现有六状态边界、离线重试及偏好持久化证据沿用 SET-02／SET-05；未改动的云端账户和工作区切换不另开全流程验收。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

本任务完成即允许第一阶段收口，不以 SET-07 至 SET-19 全部完成为前提。文档编写本身不触发这些构建和 UI 运行。

## 关联任务

[SET-20](./20-roadmap-closeout.md)

## 实施记录

- 记录日期：2026-10-17；iPhone 局部证据沿用 SET-02 至 SET-05，iPad 尚未开始。
- 协议／范围结论：本项是设置入口集成验收，不新增云端协议；用户选择暂缓 iPad 后，不能将全设备标准写成已通过。
- 已有证据：`.artifacts/settings-reorder/ui/results.json` 中 iPhone 英文浅色／深色均通过，截图及视频在同目录。下一步只补上述 iPad 设置页局部检查。
- 未解决问题：只保留 iPad 宿主局部检查；上方未勾的整体验收标准仍不算通过。2026-10-18 收口时，早期 `.artifacts/settings-reorder/` 已不在本 checkout；历史路径保留作定位，需要重审时恢复归档或重新采集，不声称本轮已重读旧媒体。

- 2026-10-17：用户明确搁置 iPad，先推进 SET-07；本文件保留未运行项，不将暂缓记为验收通过，也不阻塞本次工作区通用入口接入。
