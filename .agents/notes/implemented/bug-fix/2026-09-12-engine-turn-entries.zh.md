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
  显示"已完成"。Kimi ACP server 现在会在 `turn.started`、首个内容增量之前发出仅含元数据的
  所有权标记，因而保护覆盖整个引擎轮次生命周期，而不是延后才开始。
- 自主条目的 Session Stop 会在取得 rewrite barrier 前后，都把该条目 id 解析为当前活动标记。
  只有相符的 ACP owner 才会收到 session 级 cancel；活动标记和 presence 的清理也绑定 owner，
  因而迟到的 Stop 不会抹掉替换后的引擎轮次。
- 需要 prompt 的 Goal action 把引擎活动标记视作已占用的 session prompt slot。其 worker 会等
  匹配的终结标记、进程终止或成功 Stop 释放该 slot，随后在提交给 provider 前再次检查。Kimi 的
  起始标记关闭了此前“首条带标更新之前”的窗口；未打标 provider 仍保留旧限制。
- 删除 session 也是引擎释放边界：MessageHandler 在丢弃 transient session state 前清除标记并
  唤醒 Goal waiter，因此 eviction 不会把 waiter 永久挂在已删除的 session 上。

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
- 把引擎 owner 表示为伪造的客户端 `activeTurnId` 也被否决：客户端 release waiter 标识的是
  真实 `TurnRuntimeState` owner，`auto:<n>` 会制造错误的 release signal。独立的
  engine-release waiter 保持这条边界，同时仍让 Goal admission 等待。
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
  `apps/cli`（`session-transient-store`）的自主目标门控（来源与 `auto:` 前缀）、仅元数据
  起始标记的路由、引擎轮次活动置位/清除/替换；kimi `acp-server` 的引擎轮次打标、fork
  序号互斥、起始/终结标记发送；以及旧版已完成轮次 forkability 的恢复。
- 在第二个生产 session 复现了状态侧症状（task-wake 变体）：引擎轮次的输出合并进已完结
  轮次，同时 `executionState` 停在 `idle`——本修复的活动标记覆盖的正是这种不可见性。
- 第一轮 UI 复查暴露了引擎轮次的展示缺口：没有来源提示时，自主条目无法与用户轮次区分。
  这正是持久化 `acpTurnOrigin` 字段的动机；来源分隔行仍是后续工作，不在本次范围内。
- 验证结果按 package 分开记录。`apps/cli` 完整套件运行了 262/263 个文件，2,749 个用例
  通过、1 个失败、3 个跳过；唯一失败是已知的 macOS `/var` vs `/private/var`
  worktree-GC 断言。Kimi `acp-server` 运行了 15/16 个文件，163 个通过、1 个失败；失败是
  已知的本地 bash 回退 e2e 断言。components 运行了 455/456 个文件，3,477 个通过、1 个
  失败；失败来自未改动的 `app-store-review-prompt-hook.test.tsx`。本次改动范围的定向测试，
  包括遗留 Fork 回归测试，均通过。
- 定向 follow-up 覆盖验证了自主 Stop 的 owner 匹配与替换保护、引擎释放后的 Goal admission、
  删除边界释放、仅元数据起始标记路由、旧版已完成轮次的 forkability，以及提交给 provider
  前的引擎复查。
- 尚未在携带新 Kimi 起始/终结标记的 managed runtime 上验证完整 live 行为；这需要下一个
  kimi managed-runtime artifact。
