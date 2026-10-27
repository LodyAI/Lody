# Agent 用量 UX：先比较入口，再决定是否新增页面

Status: proposed
Type: feature
Translation: current

[English](2026-10-26-agent-usage-ux-research.md)

## 摘要

在按机器管理的配置下追加独立额度总览，会重复身份并造成范围冲突。公开产品调研区分了配置、供应商当前容量与历史消耗。用户现在要求在 Agents 内提供两种视图，通过一个图标按钮切换配置和账号额度，共用 Provider 行组件与操作。配置使用机器标签，额度跨全部可见机器按 Provider 分组，每行标明机器。AI Usage 恢复为能力门控的消耗分析。用户明确切换需要变为 Provider 分组；账号身份尚未验证，各来源记录仍分别保留。视觉结果待评审；配额历史、下拉展开与余量分布继续移除。

## 2026-10-26 核对的证据

| 产品与一手来源                                                                                                                                   | 已有文档说明的行为                                                                                                                              | 参考价值与限制                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Conductor 0.75.0](https://www.conductor.build/changelog/0.75.0-polish) 与 [Harness 文档](https://www.conductor.build/docs/reference/harnesses)  | 悬停 Codex 会话的上下文环，可查看账号限额/重置时间、本次会话 Token、套餐与认证信息。Harness 设置配置凭据/模型；模型费用归 Provider 账号。       | 接近工作区编排产品。已核实的配额交互特指 Codex，不能推断所有 Harness 都支持。      |
| [Claude Code 命令](https://support.claude.com/en/articles/14553413-claude-code-cheatsheet)                                                       | `/usage` 查看套餐限额和限流状态；`/cost` 查看当前会话用量/费用；`/context` 对应上下文占用；`/config` 打开设置。                                 | 不同命令对应不同范围；CLI 交互不能直接证明桌面导航布局。                           |
| [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel#token-usage-and-compaction) 与 [Billing](https://zed.dev/docs/account/billing)             | 当前线程的 Token 显示在输入区的 profile 选择器附近；托管服务账单和发票通过账号 Dashboard 查看。外部 Agent 的支持能力有差异。                    | 线程/上下文 Token 不是订阅剩余额度。Zed 也明确区分模型与提供该模型的 Provider。    |
| [Cline Provider](https://docs.cline.bot/getting-started/cline-provider) 与 [认证](https://docs.cline.bot/getting-started/authorizing-with-cline) | 设置中选择 Provider 和认证；Cline 积分与 View Usage 以账号为范围，组织选择决定费用记到哪个账号。                                                | Cline 自己的统一计费池，不能直接等同于多个第三方订阅聚合。                         |
| [CodexBar README](https://github.com/steipete/CodexBar) 与 [UI 契约](https://github.com/steipete/CodexBar/blob/main/docs/ui.md)                  | 菜单卡展示配额窗口与重置时间；Overview 比较 Provider/账号并进入详情；Settings > Providers 管来源；Usage & Spend 展示历史估算、账号/来源和趋势。 | 适合参考监控，但监控就是该产品的主要任务。不能由此认定编排应用也需要新增设置分类。 |
| [OpenCode CLI](https://opencode.ai/docs/cli/#stats)                                                                                              | `stats` 查看会话 Token/费用历史，可按天数、模型和项目筛选；认证有单独的命令路径。                                                               | 支持凭据与历史消耗的区分，不从 CLI 文档推断桌面配额布局。                          |

来源是官方公开文档、更新说明和维护中的源码文档，未登录操作竞品的原生应用。公开截图证明对应版本的视觉形态，不保证每个当前版本或 Provider 都相同。检索 OpenAI 文档时发生了到 ChatGPT Desktop 共用参考页的重定向，因此不据此断言当前独立 Codex 应用的导航位置。

## 职责与范围

| 页面              | 问题与范围                         | 内容                                                                   |
| ----------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| Agents / 配置     | 配置当前机器上的 Provider          | 既有身份、配置事实、紧凑额度、编辑/菜单和直接预测入口                  |
| Agents / 账号额度 | 跨可见机器按 Provider 查看当前额度 | 共用记录行组件与操作，展示所属机器、完整窗口、重置时间、余额或未知状态 |
| AI Usage          | 回顾所选周期内工作区记录的消耗     | 既有总量、活动/日历、每日详情、模型/成员明细和分享                     |
| 会话              | 工作时查看所选配置/模型            | 保留 `SessionUsagePopover`；新增比较快捷入口仍待后续                   |

额度来自供应商，可能包含 Lody 或当前工作区之外的活动；消耗来自工作区记录。
两者不能通过模型家族直接对账，也不能合成一个总剩余百分比。不能仅因名字、
套餐或品牌相同，就将多个配置合并成一个账号。

## 共用记录行的实现

配置视图使用 `MachineProvidersSection`，额度视图使用
`AgentsProviderQuotaView` 遍历全部可见机器及配置。两者共用 `ProviderRow`
实现，保留编辑、菜单、二进制进度和直接预测入口。额度视图改变分组和用量
槽位，在记录行标明机器，并与参考视图共用 `ProviderQuotaWindows`。
仍由现有行级能力/在线门控刷新和缓存值负责额度，不增加第二个刷新所有者。

切换时机器标签替换为 Provider 区块，切回时保留选中机器。分组使用运行时/
目录身份和解析出的品牌，不使用消耗模型家族的 `other` 桶。跨机器编辑明确
指向记录行所属机器，缺少可见机器的配置不展示。分组不去重账号或合并百分比。
未知与离线来源保留缓存/未知含义，全部上报窗口直接显示，不提供下拉、历史
或余量分布。

AI Usage 移除额度标签并恢复 `usageAnalytics` 门控。删除原 `UsageOverview` 和
`AgentQuotaSettings` 宿主，避免重复目录，本地 Agents 不挂载云端消耗 Hook。
旧 Provider/机器混合消耗表与等待样例仅作参考；准确来源归因和会话等待数据
仍未接入。

## 图标动效

标题区使用既有 UI 图标按钮与 Tooltip。额度与列表图标放在同一个固定格子中，
同时交叉淡化并带模糊。进入/退出使用局部命名 tween 常量，遵循 Fluid
Functionalism 的图标切换模式；模糊需要 tween。减少动态效果时禁用模糊并保留
淡化。按钮有稳定的无障碍名称与按下状态；切换不等待动画决定就绪，也不增加
内容滑动或布局动画。

## 验证与限制

Provider 渲染测试覆盖同一身份在紧凑/完整额度间切换，并保留编辑、套餐、未知
重置状态和直接预测操作。分组测试覆盖多机器、不同品牌、不可见来源和所属
机器编辑。既有模型、用量和机器详情测试覆盖周边行为。执行
类型检查、范围内 lint、翻译和平台/公开边界检查；文档错误与初始状态对比。
浏览器在合成故事中检查两种视图、机器到 Provider 的分组切换、窄/宽行、图标动效和减少动态
效果；未操作已安装 Electron 应用。环境为低于仓库下限的 Node 26.11.1，缺失
ACP 工作区包导致公开边界检查无法通过；不声称完成全仓验证。
