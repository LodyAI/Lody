# SET-16 补齐工作区 AI 用量统计

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                   |
| -------- | -------------------------------------- |
| 阶段     | 第三阶段                               |
| 优先级   | P2                                     |
| 状态     | 已完成（首版）                         |
| 依赖     | [SET-06](./06-phase-one-acceptance.md) |
| 当前授权 | 已授权按 09 → 13 → 14 → 15 → 16 推进   |

## 目标

建立口径清楚的 Token、预估费用与团队趋势入口，避免把供应商订阅额度当成消费统计。

## 当前依据

Agent 页已有额度窗口；消息详情也展示单条 Token 信息。两者均不是已确认的工作区聚合统计、费用和团队趋势接口。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/features/settings/agent-usage.ts`
- `apps/mobile/src/features/sessions/messageDetails.ts`
- [packages/cloud-runtime/src/models/agent-usage.ts](../../../../packages/cloud-runtime/src/models/agent-usage.ts)
- [packages/cloud-runtime/src/protocol/agent-usage.ts](../../../../packages/cloud-runtime/src/protocol/agent-usage.ts)
- `apps/mobile/tests/cloud/agent-usage.test.mjs`
- `apps/mobile/src/screens/SettingsScreen.tsx`

## 工作内容

- [x] 核实统计接口、时间范围／时区、用户／工作区口径、缓存／推理 Token 分类、费用来源和管理员权限。
- [x] 先实现有可靠来源的最小汇总，再按接口支持扩展趋势和团队明细；未提供费用时明确不可用。
- [x] 显示数据截止时间、估算标识、单位、币种及离线／部分失败状态。
- [x] 复用现有额度显示，保持独立语义和入口关系，不扫描本机会话凑出不完整的团队总数。

## 验收标准

- [x] 汇总与服务端读回或可信 fixture 对账，边界时间和部分数据不会重复计数。
- [x] 未知费用不显示为 0，预估不显示为实际账单，额度比例不显示为 Token 消费比例。
- [x] 成员权限不会泄露他人明细；工作区切换时旧请求和缓存正确隔离。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不硬编码推测单价或把现有聊天记录求和当成完整用量。

## 关联任务

[SET-09](./09-agent-management.md) · [SET-20](./20-roadmap-closeout.md)

## 2026-10-17 协议预查

已在[官方公开客户端契约](https://github.com/LodyAI/Lody/blob/main/packages/cloud-api/src/index.ts)找到工作区 summary、timeline、calendar 与 day 查询。范围为 day／week／month／total；timeline 返回服务端的起止时间、bucket 大小、Token／USD 汇总及成员／模型维度，部分部署另有 Token 类别明细。

首版使用 summary／timeline，保留服务端时间边界和费用来源；缺字段、权限失败或部分数据不可转成 0。首版仅投影工作区汇总和 UTC 时间段，费用标为云端预估，不展示成员明细或扫描本机会话补齐。本仓适配已完成；尚未调用真实统计。

## 实施记录

- 开始日期：2026-10-17。
- 已接入官方 summary／timeline，支持 day／week／month／total。优先显示 timeline 的完整服务端汇总；仅 summary 可用时明确提示无时间边界，不拼接两种来源或扫描本机会话。
- 展示 Token、USD 预估费用、已报告 Token 分类、UTC 服务端区间和读取时间，以及最近 30 个服务端时间段；未知费用与真实 0 区分。
- 缓存只在当前页面内存中，按账号／工作区／时间范围隔离；刷新失败保留当前范围上次确认值，部分失败保留可用来源，旧范围迟到请求不能覆盖新范围。
- 原生只投影工作区汇总和趋势，删除响应中的成员姓名、邮箱与明细；首版不展示成员级明细。重复时间段、越过结束边界、非法计数和工作区／范围不符均拒绝。
- 验证：原生和页面行为检查覆盖未知费用、真实 0、部分失败、时间边界、成员隐私和 JSON 时间戳格式。iPhone 英文浅色／深色交互验收通过。
- 未跑项：真实云端统计对账、成员级明细和 iPad；费用仅为云端估算，不作为实际账单。

- 验收证据：[本轮设置验收](https://app.lobehub.com/acceptance/49fe2ad2-5420-4cb5-a9a1-abb2e3f8203c)，对应 SET-16 的英文浅色／深色截图与录像。
