# 轮次详情弹层显示每轮 token 用量与费用

Status: implemented
Translation: current
Date: 2026-09-25
Updated: 2026-10-17
Language: Chinese
Other language: [English](2026-09-25-turn-token-usage.md)

## 摘要

用户以前能看到每轮的模型和运行配置，却看不到这一轮用了多少 token、花了多少钱。现在
CLI 把路由到每个 assistant 轮次的 Core 用量 `delta` 加总起来，写入 history 条目上
的 `tokenUsage` 字段；轮次详情弹层显示输入、输出和缓存 token，并在 provider 或
adapter 上报了费用时显示这一轮的费用。DSH 会为 DeepSeek 官方端点上报 `costUSD`，
本次变更把这个值持久化并展示出来。只有每个贡献都有已知价目时才显示费用；否则存储值
为 `null`，花费预估行不显示，避免把部分估算当成整轮费用。费用始终是估算或 provider
账单，不是发票。

## 决策

- **存储**：`tokenUsage` 是 assistant history 条目上的原始 JSON 值，和 `modelInfo`
  一样声明为 `schema.Any`，旧客户端会忽略它。
  - 通过 `assistant-token-usage` history 动作写入。
  - 该动作在已存的值上累加，而不是覆盖。所以轮次重新打开、或轮次结束后才到达的
    上报，都会继续累加。
  - 新写入由 `HistoryEntryWriteSchema` 校验。
  - `costUSD` 是同一值上的可选、可空字段。缺省表示没有任何贡献上报费用；`null`
    表示至少有一个贡献没有已知价目。一旦未知，整轮保持未知，而不是变成部分合计。
    这与 Core `sumModelUsage` 的规则一致：未知费用继续传播，不会变成 `$0`。
  - 费用支持之前写入的行有 token 但没有费用。之后到达的已知 delta 会让该轮保持
    未知，而不是用它给整轮所有 token 定价。
- **归属（CLI）**：
  - delta 到达时，计入当前拥有 ACP 输出的 assistant 条目
    （`getCurrentACPUpdateTarget`）。
  - 进行中轮次的 delta 先暂存在内存里，轮次结束时一次写入。
  - 轮次结束后才到达的 delta（此时目标是已结束的轮次），立即加到该轮上。
  - 切换到已结束轮次之后再 flush 一次，兜住在这两步之间到达的 delta。
  - 没有 `delta.usage` 的更新不贡献任何值。有 token 但 `costUSD` 不是有限非负数的
    更新贡献未知费用，而不是“没有费用”。
- **显示**：输出包含推理，缓存是读取加写入。token 数值用 `formatCompactNumber` 按
  产品语言格式化，英文显示为 K/M，中文显示为万/亿。`costUSD` 是数字时，在同一
  Token 用量区块末尾追加一行花费预估；金额用 `formatUsdAmount` 格式化，小于一分钱
  时保留更多小数位，悬停提示说明这是估算而非发票。只要有 token 用量（包括只有费用
  的记录），就会显示信息按钮。

## DSH 的费用来源

DSH 的 `src/usage.ts` 在每条 `assistant/message` 完成时，按 DeepSeek 官方价目表
计价，并应用公开的 UTC 工作日高峰/低谷倍率；只有路由是官方端点
（`!baseUrl || isDeepSeekOfficialBaseUrl(baseUrl)`）且模型有价目时才计入。Core 的
`SessionUsageAccumulator` 只有在 delta 中每个模型行都有费用时，才把 `costUSD`
放进 `delta.usage`。因此宿主不在渲染层重新发明或重算价格。

## 备选方案

- **从累计的 `modelUsage` 推导**：每个范围都需要基线，而基线会在重启时丢失。
  未采用。
- **每个 delta 立即写入**：每次模型回复都会产生一次 history 写入。改为每轮只写
  一次，外加迟到上报的写入。未采用。
- **挂在 `modelInfo._meta` 下**：会把显示数据藏在 provider 元数据里。未采用。
- **在 UI 里用本地价目表和 token 重算费用**：这会在第二个包里复制价目，无法复现
  DSH 按请求时间选择高峰/低谷的做法，还会给故意没有已知价目的自定义端点定价。
  未采用。
- **只显示已知部分**：把偏小的数字当作整轮费用，比不显示更糟。未采用。

## 限制

- 按到达时间归属。在后一轮进行中才到达的后台结果，会计入后一轮。
- 暂存的 delta 只在进程内存里。如果 CLI 在轮次结束前退出，这部分会丢失。
- 费用是每个 assistant 轮次的费用，不是会话总计。汇总花费仍看 workspace 用量页。
- 自定义 DeepSeek 端点、未知模型或缺少时间戳时，DSH 不产生费用。DSH 的价目是
  带日期的估算，不是发票；跨价格边界的请求可能与实际账单不同。
- 每轮费用只来自用量 delta。CLI 持久化 Codex/Kimi 汇总用量时使用的旧价目表不会
  套用到轮次记录上，所以这些轮次只有 token，除非它们的 adapter 自己上报费用。
- 早于该字段的消费端会忽略 `costUSD`，继续只显示 token。

## 验证

- shared `session-history-actions`：跨 finish 和迟到上报的累加、已知费用相加、
  未知费用传播、拒绝负费用和非法值、忽略用户轮次。
- CLI `turn-token-usage`：delta 费用映射、未知价目、零 token 和无 delta 的更新、
  ledger 累加。
- components `agent-activity-row`：紧凑数值、悬停显示精确值、费用行与估算提示、
  只有 token 用量时也显示弹层。`TurnTokenUsagePopover` story 包含花费预估行。
- 本次变更的验证限制：编辑环境没有安装 workspace 依赖，因此这里没有执行类型、
  单元和格式检查；新增测试与 Storybook 状态仍需由 CI 或本地安装后运行。
