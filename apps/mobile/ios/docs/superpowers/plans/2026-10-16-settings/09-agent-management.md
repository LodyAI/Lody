# SET-09 完善 Agents 设置与现有额度展示

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                           |
| -------- | ---------------------------------------------- |
| 阶段     | 第二阶段                                       |
| 优先级   | P1                                             |
| 状态     | 已完成（现有配置／额度整理）                   |
| 依赖     | [SET-05](./05-home-sections-and-connection.md) |
| 当前授权 | 已授权按 09 → 13 → 14 → 15 → 16 推进           |

## 目标

整理按机器分组的 Agent 配置、编辑能力与额度说明，并明确和 Agent 角色的区别。

## 当前依据

已有按机器分组的 Agent 列表、名称与 prompt 编辑，以及供应商订阅额度窗口。远程模型不向 RN 投影 env／secret，现有测试验证保留未知字段和秘密。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/features/settings/remote-settings.ts`
- `apps/mobile/src/features/settings/agent-usage.ts`
- `apps/mobile/src/screens/RemoteSettingsScreen.tsx`
- `apps/mobile/src/screens/RemoteSettingEditorScreen.tsx`
- [packages/cloud-runtime/src/runtime/settings.ts](../../../../packages/cloud-runtime/src/runtime/settings.ts)
- `apps/mobile/tests/native/settings.test.mjs`
- `apps/mobile/tests/cloud/agent-usage.test.mjs`
- `apps/mobile/verification/ui/settings.py`

## 工作内容

- [x] 保持机器分组，明确 Agent 配置的来源、只读原因和供应商额度含义。
- [x] 核对官方支持字段与当前 name／prompt 编辑边界；逐项决定是否补，不默认扩展任意 JSON 编辑。
- [x] 核实新增、删除、启用等管理协议；需要秘密输入的能力留在经过验证的原生安全边界。
- [x] 保留额度的缓存／离线、未知重置时间和自定义 API 不适用等状态。
- [x] 在名称与说明中区分 Agents、Agent 角色和工作区 AI 用量。

## 验收标准

- [x] 不同机器上的同名 Agent 不混淆，权限和缓存按用户／工作区／机器正确隔离。
- [x] 保存修改不覆盖 env 和未知字段；敏感内容不进入 RN、日志、fixture 或诊断。
- [x] 额度缺失、离线、重置时间未知均不显示为零消费或实时结果。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

首版不做通用 Agent 配置编辑器；订阅额度不作为 Token 费用统计。

## 关联任务

[SET-11](./11-agent-roles.md) · [SET-16](./16-ai-usage.md) · [SET-20](./20-roadmap-closeout.md)

## 实施记录

- 开始日期：2026-10-17。
- 协议／范围结论：本轮完成现有 Agent 配置与额度的信息架构，不扩成完整配置器。按机器保留配置组，另列该机器的订阅额度；同供应商窗口只显示一次，并加供应商名称。机器 ID、配置刷新时间、只读原因、缓存与额度语义独立说明。账号也进入列表组件的作用域 key，避免同工作区账号切换沿用旧配置快照。
- 官方字段核对：参考公开客户端的 `agent-config-dialog.tsx`、`machine-agent-settings.tsx` 与 `atoms/agents.ts`，除 name／prompt 外还存在 CLI 类型、env、运行覆盖、认证和创建／删除路径；不是单一通用启用开关。本仓继续只开放已验证的 name／prompt，保留 env 和未知字段；本轮未接入这些额外写入，不能据此宣称官方不支持。
- 原生兼容修复：当前工作树已升级 Expo 58／RN 0.88；原自定义 SceneDelegate 只转发旧 AppDelegate URL 回调，导致 Debug 场景链接无法进入。配置插件改为继承 SDK 的 ExpoAppSceneDelegate，复用官方窗口、生命周期与链接转发；变更持久化于插件，未仅修改生成目录。离线验收的跨外观返回也改为现有 Router dismissTo，替换 Expo 58 不处理的原导航 RESET。
- 验证与证据：19 个定向行为检查、31 个 UI runner 检查、`pnpm check`、`pnpm bundle` 已通过；标准签名 iOS Simulator 构建通过。Agents 专用英文浅色／深色验收均通过（171.27s／167.96s），已查看截图和录像抽帧；输入卡片与底色差值为 13／41。证据在 `.artifacts/settings-set-09/ui-fixed/`，行为执行记录在 `.artifacts/settings-set-09/behavior-checks.log`。未运行整套机器／MCP／聊天或 iPad 回归。
- 验收链接：[SET-09 Agents 设置整理](https://app.lobehub.com/acceptance/d4d61a8c-4dbc-4282-acd1-8264d793b02e?r=1)；3／3 条目通过，全部必需截图、录像与文本证据已上传。
- 未解决问题：真实云端写入与完整 Agent 创建／删除／秘密配置未在本轮接入或验证；额度来源仍是机器报告的供应商级订阅窗口，不能推断独立账号账单或工作区 Token 用量。
