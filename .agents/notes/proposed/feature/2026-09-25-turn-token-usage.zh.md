# 轮次详情弹层显示每轮 token 用量

Status: proposed
Translation: current

[English](2026-09-25-turn-token-usage.md)

## 摘要

用户以前能看到每轮的模型和运行配置，却看不到这一轮用了多少 token。现在 CLI 把
路由到每个 assistant 轮次的 Core 用量 `delta` 加总起来，写入 history 条目上新增的
`tokenUsage` 字段。轮次详情弹层用紧凑单位显示输入、输出和缓存 token，悬停时显示
精确值。之所以用 delta，是因为 adapter 算 delta 时能保证 resume 后不重复计数（见
[用量范围](../bug-fix/2026-09-25-usage-accounting-scopes.zh.md)）；累计值需要为每个
范围维护基线，因此不用。不发送 `delta` 的 adapter，这一轮不显示用量，不做估算。

## 决策

- **存储**：`tokenUsage` 是 assistant history 条目上的原始 JSON 值，和 `modelInfo`
  一样声明为 `schema.Any`，旧客户端会忽略它。
  - 通过新增的 `assistant-token-usage` history 动作写入。
  - 该动作在已存的值上累加，而不是覆盖。所以轮次重新打开、或轮次结束后才到达的
    上报，都会继续累加。
  - 新写入由 `HistoryEntryWriteSchema` 校验。
- **归属（CLI）**：
  - delta 到达时，计入当前拥有 ACP 输出的 assistant 条目
    （`getCurrentACPUpdateTarget`）。
  - 进行中轮次的 delta 先暂存在内存里，轮次结束时一次写入。
  - 轮次结束后才到达的 delta（此时目标是已结束的轮次），立即加到该轮上。
  - 切换到已结束轮次之后再 flush 一次，兜住在这两步之间到达的 delta。
- **显示**：输出包含推理，缓存是读取加写入。数值用 `formatCompactNumber` 按产品
  语言格式化，英文显示为 K/M，中文显示为万/亿。只要有 token 用量，就会显示信息按钮。

## 备选方案

- **从累计的 `modelUsage` 推导**：每个范围都需要基线，而基线会在重启时丢失。
  未采用。
- **每个 delta 立即写入**：每次模型回复都会产生一次 history 写入。改为每轮只写
  一次，外加迟到上报的写入。未采用。
- **挂在 `modelInfo._meta` 下**：会把显示数据藏在 provider 元数据里。未采用。

## 限制

- 按到达时间归属。在后一轮进行中才到达的后台结果，会计入后一轮。
- 暂存的 delta 只在进程内存里。如果 CLI 在轮次结束前退出，这部分会丢失。
- 不显示费用。未知费用需要另外定义显示语义。

## 验证

- shared `session-history-actions`：跨 finish 和迟到上报的累加、拒绝非法值、
  忽略用户轮次。
- CLI `message-handler-acp-batching`：真实的 MessageHandler 加 Loro 文档，
  只按 delta 归属、迟到上报、两轮互不干扰。
- components `agent-activity-row`：紧凑数值、悬停显示精确值、只有 token 用量时
  也显示弹层。
