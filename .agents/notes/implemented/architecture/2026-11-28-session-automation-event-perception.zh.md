# 会话自动化作为事件感知：槽位取代与介质无关的因果深度

Date: 2026-11-28
Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/3519

[English](2026-11-28-session-automation-event-perception.md)

## 摘要

一次性自动化等待正被 agent 串成链条来模仿定时器：每次唤醒在自己的续航文本里
重新注册下一条等待。真实使用中，一个巡检家族 13 小时重注册 97 次，账本堆积
数百条失效但仍武装的记录，会话底部挂满过期续航注释；跨会话消息风暴则完全
逃过 16 跳因果预算，因为经账本投递的输入不携带任何深度。本笔记记录
[会话自动化事件 Spec](../../../../specs/session-automation-events.zh.md)背后的
收敛设计：automation 只感知状态跃迁（时间触发的工作归 Schedule），每次注册
占用按名取代的槽位，自动化续航接入从因果记录派生的既有深度计数。周期注册、
意图级去重、派发合并、时钟摘除与按会话出站开关均已评估并否决。设计已在对话
中评审并达成一致，随 PR #3519 落地，合成集成测试覆盖取代围栏、深度派生、
结算与账本退役；现场证据数字来自报告者，未运行真实多 agent 复现。

## 现场证据

两份独立报告，均与代码检视一致：

- [LodyAI/Lody#3477](https://github.com/LodyAI/Lody/issues/3477)：一个长寿命
  工作区累积 1105 条 automation rule；单个“8 分钟监督巡检”家族约 13 小时
  重注册 97 次；571 条等待停在 `matched`；576 条 rule 在等待交付后仍然
  `enabled`；一条 receipt 排队约 3 小时；每个会话挂出一打雷同芯片。
- 一位协调多个 Worker 会话的 Coordinator 注册了 15 分钟检查，其续航文本携带
  完整协调指令。该工作区记录 1133 次条件完成与 3533 次容量唤醒；每次唤醒
  重新注入指令文本，压过用户后来在对话里说的“少发点消息”，并扇出为跨会话
  steer 流量。用户报告的接力链（注册、十分钟后唤醒、再注册）展示了单会话内
  同一种自我续杯模式。

## 现行代码中已核实的放大器

以下每条论断均于 2026-11-28 对照工作区核实：

- **账本路径上因果深度从未被计数，而非仅仅被重置。**
  `apps/cli/src/automations/actions/session-actions-legacy.ts` 的
  `prepareInvoke` 只从历史继承 model/mode/config 值，唤醒输入完全不携带
  `chainDepth`。`apps/cli/src/mcp/lody-mcp-server.ts` 的准入闸对每个自动化
  驱动的回合读到的都是 `undefined ?? 0`——16 跳熔断对账本回路失效，对
  steer 与重注册交替的混合回路则沦为免费的预算重置阀。
- **结算倒退。** 同一文件的 `reconcile` 中，已经 `handled` 的回合只要
  `hasAutomationSessionWork` 为真就穿透到 `queued`——而该谓词包含仍在其他
  会话运行的委派 Operation（`hasPendingWorkForRequester`）。已完成的唤醒在
  任何子工作存续期间都显示为“条件已满足，等待执行”。这道闸源自 automation
  初版 PR（#1952），不是后期回归；它把收据的投递合同与会话的全局工作态
  错误耦合。
- **字节级去重被构造性击败。** `apps/cli/src/automations/storage/ledger.ts`
  的 `registerWait` 要求 program 文本、间隔、过期时间与理由全等；定时器
  条件每个周期内嵌新的绝对时间戳，措辞漂移即使没有触发时间戳也足以击败。
- **死 rule 永不退役。** `finishWait` 插入的一次性续航 rule 永久保持
  `enabled`；`publish()` 对每个事件反序列化全部 rule；`list` 不过滤终态行；
  没有任何清理。
- **零观察校验是死代码。** 注册时传入 `validateOnly: true`，但
  `evaluateAutomationProgram` 在该模式下解析完即返回，
  `AUTOMATION_VALIDATION_HAS_NO_READS` 不可达——今天注册纯 `ctx.now`
  定时器畅通无阻。
- **归档泄漏 exec/fetch 等待。** `ctx.read` 会复查会话状态，归档会话上的
  读取抛错并在连续五次后终结等待；但只用 `ctx.exec`/`ctx.fetch` 的条件绕过
  该检查，归档后永久轮询——被拦的只有投递。
- **唤醒输入与人类消息无从区分。** 续航文本原样构成整个输入，没有任何来源
  标注，agent 无法分辨自动化唤醒与用户回合；过期的链式指令以最新“系统
  指令”之位重新入场。
- **摘除时钟不可行。** `@opencode/codemode` 2.2.0 将 `Date` 实现为沙箱内建
  （`stdlib/date.js`），删掉 `ctx.now` 后 `Date.now()` 依然可用；`ctx.exec`
  还能调用 `date` 命令。删除 `ctx.now` 只是表态而非机制，还会破坏合法的
  新鲜度比较（`ctx.now - observedAt`）。这推翻了最初的设计直觉；真正的闸是
  观察要求与因果深度。
- **文档漂移方向与最初假设相反。** `autoDeliver.merge` 默认 `true` 是 #3296
  的刻意产品决策；过期的是 `references/settings.md`，不是 schema。

## 决策

契约由 Spec 承载；以下是塑造它的推理：

- **事件感知对时间。** Automation 感知状态跃迁与进程退出；时间可以调度
  观察，但永远不构成事件。时钟唤醒已有属主——Schedule，带人类确认、单实例
  管理与暂停。agent 自建的 `ctx.now` 接力链是一道绕过该授权面的免审批
  cron，因此设计拒绝这个需求，而不是更好地服务它。
- **槽位取代。** 注册属于其 key 或未命名默认槽；注册即原子取代槽内未完成
  等待，包括撤回其尚未开始执行的续航输入。提议中的每会话 key 上限在实现中
  被舍弃：并行规模已由因果预算约束，一个无人能定大小的上限只会增加机制
  而没有被证实的危害。
  措辞漂移与压缩后的重复注册变为幂等替换。注册响应免费携带活跃等待清单，
  agent 无需额外一轮 `list` 就能看到自己取代了什么、还有什么在挂起——这
  化解了无关等待共享默认槽时被静默丢弃的风险。
- **因果深度从历史派生。** 准备续航输入时计算深度：最新的 user-role 回合
  即决定深度：人类输入归零（链深回到 1）；机器成因输入
  （账本唤醒、委派 chat 或 steer）在其记录的深度上加一；无深度记录的机器
  回合保守记为一跳。无注册时捕获、无新增 wait 列，CLI 与 MCP 注册路径行为
  一致。深度绑定会话连续性而非单条等待的血缘，恰匹配真实危害——对话自身
  的无人值守自转。
- **零观察结果无效。** 求值时动态执行：未调用任何 `read`/`fetch`/`exec` 就
  产生的结果使该等待以确定性编程错误失败，首次即失败，不计入通用检查错误。
  原计划注册时的静态 AST 提示被舍弃：动态闸在第一次检查时即生效，而别名
  在构造上击败静态分析，启发式撑不起它的文档重量。
- **provenance 前缀。** 续航输入仅以来源事实开头（等待 id、理由、注册时间），
  符合不变量：Lody 发给 agent 的文本携带事实，绝不携带工作流指挥。更丰富的
  头部（介入的人类回合数、活跃等待摘要）已舍弃：人类回合本来就在 transcript
  里，清单由注册/查询响应覆盖。

## 被否方案

- **周期注册（`repeat`、`everyMs`）——#3477 的头号诉求。** 它把免审批 cron
  合法化：带外部副作用的周期性 LLM 唤醒，正是 Schedule 要求人类确认的那类
  东西。有界租约变体（`maxRuns`）只是在谈判绕过的大小。所有合法的链形需求
  都可分解给现有属主：CI/PR 循环归 Auto delivery；子会话监督归 Operation
  Inbox 回执；外部状态归 Host 零 token 轮询、在真实跃迁时只唤醒一次的单次
  等待；周期性判断归 Schedule。
- **意图级去重**（剥离字面量的 AST 归一化，或按理由文本去重）。程序是不透明
  文本；措辞漂移击败一切启发式，而槽位机制已确定性地覆盖诚实场景。
- **排队续航的派发期合并。** 连发爆炸是链式重注册的症状，本设计已将其移除。
  修复后的残余——同一长回合内多个真独立 keyed 等待同时命中——稀有、量小、
  信息各异；合并反而丢弃事实。同槽排队场景由取代的输入撤回覆盖。
- **删除 `ctx.now`。** 表态而非机制（见上述证据）；在 `Date.now()` 仍在沙箱
  内的情况下损害合法的新鲜度逻辑。
- **独立的 automation 循环计数器。** 两份预算、两套重置语义互为洗钱通道：一种
  介质数到 15，换介质，永远不到顶。一份介质无关的因果预算是更简单的设计。
- **按会话的跨会话出站开关**（#3477 评论区的后续诉求）。默认开启、出了事才
  想起来的设置是负资产；steer 与排队的语义是 `lody_session_chat` 的通用问题，
  与 automation 无关。链死之后、监督归回执之后，流量自然崩溃，无需新设置；
  通用 chat 问题已作为未决问题记入 Spec。

## 后果

- automation 的成功度量改变：`register` 的使用量应当下降——Auto delivery、
  组结算、Inbox 回执与 `recoverCapacity` 各自吸收本该属于自己的场景。MCP
  skill 的第一职责变为导流（决策表先行），而非教授程序语法。schema 字段补齐
  描述，使 `lody_help` 输出直接展示 `ctx.read` 资源与 Auto delivery，无需
  读取 skill。
- 账本卫生（结算、48 小时保留窗后的退役、rule 关闭、归档取消、活跃行
  list 过滤）与契约变更（因果深度派生、带输入撤回的槽位取代、provenance
  前缀、观察要求）一同落地；归档会话的等待取消是收敛式的——等待在下一次
  求值、会话上下文读取永久失败时取消，而非在归档时刻。Schedule 的
  `existing_session: "current"` 仍作为未决问题留在 Spec。
- 此后可回应 #3477：槽位取代覆盖其去重意图，因果深度加槽位撤回覆盖风暴与
  过期连发机理，退役覆盖账本增长；周期定时器诉求以 Schedule 边界为由谢绝。

## 验证与限制

- 改动前的代码论断于 2026-11-28 通过阅读工作区核实；事故数字来自报告者。
  合成集成测试覆盖取代围栏、跨人类/机器输入的深度派生、零观察失败、结算
  独立性与终态清理；未运行真实多 agent 复现。
- `inputConfig`（含 `_lodyAutomation` 与 `chainDepth`）是会话文档 schema 的
  组成部分，因此 provenance 在重启后存续，并对加密会话一致适用；无深度记录
  的机器成因遗留回合保守记为一跳。
- 长无人值守流水线撞上 16 跳强制停止时，用户能否理解其原因未经测试；
  熔断是灾难上限，撞上它的正解是通过 Schedule 重新授权，而非调大数字。
- 相关活跃笔记，交叉链接而非取代：[automation 协调器](../../proposed/architecture/2026-10-25-session-automation-coordinator.zh.md)
  （本设计锐化了其“automation 不替代 Schedule”的边界）、
  [外部检查](../../proposed/architecture/2026-10-28-automation-external-checks.zh.md)、
  [托管长运行](../feature/2026-11-16-managed-long-runs.zh.md)、
  [automation 指引范围](../simplification/2026-11-21-automation-guidance-scope.zh.md)、
  以及[约束 agent 消息链](../bug-fix/2026-10-11-bound-agent-message-chains.zh.md)
  （本设计将其深度预算扩展到全介质）。
