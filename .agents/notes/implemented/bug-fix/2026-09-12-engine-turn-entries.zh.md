# 引擎自开的 agent 轮次拥有自己的历史条目

Status: implemented
Translation: current

[English](2026-09-12-engine-turn-entries.md)

## 摘要

agent 引擎可以背着客户端自己开轮次——kimi 的 cron 触发、任务唤醒——而它的 ACP server 刻意
转发这些轮次的内容。这些更新不带轮次身份，于是 Lody 把它们路由到上一个客户端轮次的
assistant 条目里：用户眼睁睁看着自己的真实答复被折叠进"思考过程"，而 cron 轮次的状态
文本成了可见答复；daemon 重启后这类更新被直接丢弃；session 在引擎轮次仍在运行时显示
"已完成"（进程甚至可能被空闲 GC 回收）。修复把轮次身份穿进 wire（引擎自开轮次带
`_meta.lody.turnId = auto:<n>` 和 `_meta.lody.turnOrigin`）并按此路由：引擎自开轮次渲染为
自己的条目、在终结标记前会话显示为忙碌；而活在一个客户端轮次内部的边界 id 保持原有
渲染。剩余的边界是部署：kimi 打标随下一个 managed-runtime artifact 发布，Lody 侧各层随
Lody 发布，对未打标的 agent 退化为旧行为。

## 不显眼的约束

迟到更新路由有其正当存在理由：轮次自身的输出可能在 `session/prompt` 返回后才落地，所以
已完结轮次始终作为路由目标、不按墙钟过期。也正是这条规则吞掉了引擎自开轮次——在路由
层看来，cron 轮次的第一个 chunk 和刚结束轮次的迟到残片无法区分。因此任何修复都需要
wire 上真实的轮次身份；基于时序或 prompt 在飞状态的边界猜测被考虑过并否决作为主要机制，
因为连续的引擎轮次和纯文本引擎轮次没有身份就无法区分（cli-only 的启发式仍是未打标
runtime 的可行兜底，用精确性换部署便利）。

## 职责划分

- kimi ACP server（`acp-extension-kimi` 子模块）给引擎自开轮次的每条更新打上
  `auto:<engineTurnId>`（非数字，永远不能被解析回 fork 位置）和来源 kind。用户可见轮次
  保持纯 fork 位置，不带来源标记。
- `@lody/shared` 的 `history-apply` 负责分组，且仅对 kimi 打标的轮次生效：`auto:` id 或
  `turnOrigin` 标记（引擎自开）仅在当前条目仍可接受增量时收养它——死后留下未打标条目的
  失败轮次不得收养打断轮次——否则创建 `assistant:autonomous-<turnId>`；其他一切 id 保持
  逐字节的旧式 last-wins 盖戳，因为 claude 的按消息边界 uuid 和 codex collab 子轮次标记的
  是同一个客户端轮次内部的边界，绝不能拆散其渲染。
- `apps/cli` 把带来源标记（或 `auto:` 前缀）的更新路由到合成的自主目标，即使存在
  active/finalized 目标：引擎自开轮次永远不属于客户端轮次的条目，提前路由还覆盖了富
  内容——它在写入时绕过分组逻辑。
- kimi ACP server 在引擎自开轮次结束时发出 `_meta.lody.turnEnded`，history apply 据此
  完结属主条目（只写一次——重复标记不得挪动终结时间）。没有这个标记，条目会永远渲染为
  流式，因为 `message.finished` 是渲染器唯一的流式判据，而完结本来只发生在客户端
  dispatch 的轮次上。来源同时持久化为 `entry.acpTurnOrigin`，供 UI 为这类轮次打标签。
- `apps/cli` 还在 transient store 里维护引擎轮次活动标记：引擎轮次首条打标更新时置位，
  终结标记或 ACP 进程终止时清除（活性以进程为界，不用墙钟——标记丢失的轮次在其进程
  死亡时立即释放会话）。`hasActiveTurn` 读取它，空闲 GC 便无法在引擎轮次中途回收 agent
  进程；live-status RPC 把 `unknown` 升级为 `running`，session 不再在引擎轮次工作时
  显示"已完成"。

## 备选与取舍

- cli-only 边界检测（finalize drain 后封存已完结轮次、之后一律进自主条目）以零跨仓协调
  覆盖主场景，但无法拆分连续的引擎轮次、daemon 重启后丢失边界，还硬编码 kimi 特判。
  保留为可行兜底，未实现。
- 否决把纯引擎轮次号当作 fork 位置打标：Lody 会把 `session/fork` 目标从 `turnId` 解析
  回来，所以引擎轮次必须是非数字。
- "对所有打标 id 分组"（本修复的第一版）在复查时被否：它把 claude 的按消息边界 uuid
  拆成空条目、把 fork 依赖的 `acpTurnId` 从真正的答复条目上偷走，还把 codex collab 子
  轮次的输出从父轮次的内联渲染里拽了出来。
- 面向普通打标 id 的通用属主路由层（把轮次 N 的迟到 chunk 路由回轮次 N 的条目）为把
  影响面收窄到 kimi 专属而砍掉：跨进下一轮次的残片保持其既有的合并行为，不为它新增
  代码路径。
- task wake 轮次现在也会渲染为独立条目，把持有中的 subagent 汇报和发起它的用户轮次
  分开。这与引擎自己的轮次模型一致，但属于可见变化，值得在 subagent UX 里验证。
- 遗留 follow-up：replay/import 不分类 cron fire，重新加载的 session 仍可能把 cron-fire
  XML 显示为普通用户消息；UI 也还没有为引擎自开轮次做来源标签，也不显示 cron 轮次的
  触发 prompt。

## 证据与验证

- 从生产 session 的 wire（`~/.kimi-code/.../wire.jsonl`）复现：一个 cron 在用户轮次完成
  后一秒触发，其最终文本被持久化为该用户轮次 assistant 条目的可见答复。
- 新增单元覆盖：`@lody/shared` 的引擎轮次分离、跨批次连续性、先死后收养的漏洞、终结
  标记完结（及其一次性的终结时间）、claude 多 uuid last-wins、codex collab 内联盖戳；
  `apps/cli`（`session-transient-store`）的自主目标门控（来源与 `auto:` 前缀）与引擎
  轮次活动置位/清除/替换；kimi `acp-server` 的引擎轮次打标、fork 序号互斥与终结标记
  发送。
- 在第二个生产 session 复现了状态侧症状（task-wake 变体）：引擎轮次的输出合并进已完结
  轮次，同时 `executionState` 停在 `idle`——本修复的活动标记覆盖的正是这种不可见性。
- 在运行本分支的 OSS 桌面 + 本地构建的打标 runtime 上完成端到端验证：用户轮次之后的
  cron 触发渲染为独立的已完成轮次；引擎轮次期间 session presence 为 `running`，终结
  标记后为 `idle`。第一轮 UI 暴露的缺口——引擎轮次毫无来源提示——正是持久化
  `acpTurnOrigin` 字段的动机，后续 PR 会把它渲染为来源分隔行。
- 两个仓库的完整套件均通过，除三个已验证在未改动树上同样失败的用例：`apps/cli` 的
  两个 Claude 凭据存储探测与一个 macOS `/var` vs `/private/var` worktree-GC 断言，以及
  `acp-server` 的一个本地 bash 回退 e2e 测试。
- 尚未在运行打标 runtime 的真实 session 里做端到端验证；那需要下一个 kimi
  managed-runtime artifact。
