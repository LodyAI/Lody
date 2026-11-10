# Session Inbox 的状态机与故障隔离

只为 Session Inbox 这一套系统建模：多端投递、输入接纳和提交、结果续跑、回复等待。产品代码已修复三条原先失败的路径，并把准备批次、诊断及同步适配器异常纳入隔离检查。这里描述已提交的修复；验证映射固定产品提交与精确源码哈希。

## 为什么选这个系统

历史统计基准为 `886ad65f0c80635063eade5add93171440af8647`。统计窗口是北京时间 **2026-08-09 至 2026-11-09**，按提交者时间筛选可达的第一父提交。只统计第一方生产源码，排除测试、故事、生成文件、vendor 和独立 ACP adapter。每次提交在每个模块中只计一次；修复采用 `fix:` / `fix(scope):` 标题识别，改动行数采用新增加删除。标题和代码量都是选择信号，不是缺陷概率。

| 模块或核心文件 | 改动提交 | fix 提交 | 新增＋删除行数 |
| --- | ---: | ---: | ---: |
| CLI Session 模块 | 210 | 139 | 51,953 |
| Session 执行核心 `session-execution-service.ts` | 111 | 68 | 10,955 |
| 消息处理入口 `message-handler.ts` | 148 | 81 | 10,218 |
| Inbox 所在 orchestration 模块 | 45 | 23 | 11,762 |
| 对照：CLI Agent 模块 | 104 | 64 | 12,799 |
| 对照：CLI Loro 模块 | 93 | 49 | 12,980 |

UI 目录也有更多修复，不能因为目录大就称其最易错。这里优先选择反复修复 **输入保留、重复消费、Stop、取消后释放、未知结果恢复和执行卡住** 的执行系统：它的错误能造成重复执行、输入丢失，或者让其他会话不能继续。选定的是本次最值得深入的高风险系统，不是统计上已证明缺陷率最高的模块。

[统计脚本](../verification/state-machines/history.py) 按上述基准生成候选排名与代表性公开修复提交，输出到仓库外。仓库是 shallow checkout，但本地第一父链始于 8 月 7 日，早于本次窗口；不声称覆盖所有远程分支。重新统计：

```sh
python3 .agents/verification/state-machines/history.py --revision 886ad65f0c80635063eade5add93171440af8647 --out /tmp/lody-session-selection.json
```

## 状态分别由谁持有

| 状态 | 所有者 | 边界 |
| --- | --- | --- |
| 待执行输入、固定批次、消费与 Stop | 执行主机的 SQLite | 已准备不等于已提交；结果未知不能重放 |
| 未确认的 pause/release/settle 写入 | 原有 Effect scope 的 Map | 失败记录保留，独立记录继续尝试；显式恢复返回合并 Cause |
| 调度唤醒与启动任务 | 合并唤醒 Queue、`running` Set | 扫描错误不能终止扫描器；启动异常必须释放其存活标记 |
| 投递失败确认 | 主机串行 watcher 写入的每输入 ID 映射 | 新消息或下一次超时不能擦掉旧失败，生产者不清理恢复确认 |
| 回复写入等待 | 每个输入自己的 TurnHistoryGate | waiting/opening/open 分开；原始期限覆盖回调，结束立即放行 |

Inbox 不在每个客户端各执行一份。其他设备通过正文同步、用户凭据、激活元数据和可选 RPC 影响执行主机；模型把不同文档/通道的到达拆开，而不是任意打乱一个 CRDT import 的因果顺序。[Spec](../../specs/session-orchestration.md#idempotent-message-consumption) 定义意图，[Session 规则](../../apps/cli/src/session/AGENTS.md) 和 [Inbox 规则](../../apps/cli/src/orchestration/AGENTS.md) 定义边界。

## 故障如何被限制在自身

[调度服务](../../apps/cli/src/orchestration/inbox/service.ts) 逐条尝试所有独立的重试记录，成功才删除对应记录，最后向显式恢复调用者返回合并后的错误。后台扫描报告这个错误后继续读待执行输入；准备一个批次失败也只跳过该项。共享写锁的 `BUSY` 例外：同连接的其他写入也依赖该锁，本轮立即停止写入并保留记录；scope 内的单个重试从 250ms 退避到最多两秒，期间合并扫描唤醒。显式输入不等待这个标记；解锁后可直接提交，原队列自动重试。关闭 scope 会取消计时，成功扫描后重置延迟。单行错误与 `SQLITE_FULL` 仍继续独立工作，单次 SQL 原有的五秒同步等待没有移除。[共享写锁状态图](../skills/verify-session-execution/busy-chart.mmd) 展示退避、解锁和新输入的关系。诊断、launch 或存储适配器在返回 Effect 前同步抛错，同样被相应边界接住。中断仍结束 scope 中的任务，没有新增持久阻塞状态或运行时所有者。

下面是 pstack 生成的当前调度图。展示配置固定 B 在 A 释放执行权后到达；完整检查不采用这个到达顺序限制。展示视图合并执行阶段内的重复扫描步骤，完整诊断仍保留全部变量。

```mermaid
---
title: "会话 Inbox 调度与失败重试"
---
stateDiagram-v2
  s0: A 的原始输入已提交
  s1: A 状态写入失败#65292;原记录保留
  s2: A 已归还执行权#65292;失败记录仍需重试
  s3: B 已有可执行结果#65292;等待调度
  s4: 调度器先重试 A
  s5: 继续读取 B 的待执行输入
  s6: 准备 B 的固定结果批次
  s7: B 等待启动任务派发
  s8: B 的启动任务已派发
  s9: B 已取得执行权#65292;尚未提交
  s10: B 已提交给 Agent
  s11: B 的结果已记录#65292;等待归还执行权
  s12: B 的提交结果未知#65292;禁止重放
  s13: B 已执行一次并归还执行权
  [*] --> s0
  s0 --> s1: A 的提交状态写入失败
  s1 --> s2: A 归还执行权
  s2 --> s3: B 收到可自动处理的结果
  s3 --> s4: 开始一轮扫描
  s4 --> s5: A 的写入仍失败#65292;保留记录并继续扫描
  s5 --> s6: 读取待执行输入
  s6 --> s7: 冻结这一批结果
  s7 --> s8: 派发 B 的启动任务
  s8 --> s9: B 取得独占执行权
  s9 --> s10: 通过最后检查后提交给 Agent
  s10 --> s11: 记录 B 已完成
  s10 --> s12: 记录 B 的提交结果未知
  s11 --> s13: B 归还执行权
  s12 --> s13: B 归还执行权
```

[投递失败确认](../notes/implemented/bug-fix/2026-11-10-missing-history-acknowledgements.md) 使用 `missingHistoryUserMsgIds`，同时读取旧标量。只有同一会话串行的主机 watcher 增加记录，生产者只发布新激活，不再清除旧失败。正文/RPC 选择、待执行判断、持久接纳、Roost 激活和界面使用同一个精确 ID 判断。两次失败后，迟到的旧消息仍被排除，新 ID 仍可使用。旧超时也不能误判恢复期间刚到的新激活。

[回复等待器](../../apps/cli/src/session/turn-history-gate.ts) 在写入前回调等待期间保留原始截止时间。到期立即放行等待者，但让存活中的回调继续补齐作者和模型。只有结束这一轮时才给回调发送取消信号，即使超时已放行也要取消。[MessageHandler](../../apps/cli/src/lib/message-handler.ts) 在异步读取后、实际写入前检查该信号，防止迟到回调重新打开已结束的回复条目。finalization 在写入结束标记之前就取消本次捕获的 gate，不等到清理轮次状态，避免结束后的迟到回调重新打开条目。已经发出的写入不被当作已取消；结果继续被观察。下面也是 pstack 生成的当前图：

```mermaid
---
title: "回复写入等待与限时放行"
---
stateDiagram-v2
  s0: 等待用户正文#65292;原始期限仍在计时
  s1: 到达期限#65292;放行回复并继续补齐条目
  s2: 旧输入已结束#65292;等待已解除
  s3: 正文已到#65292;回复条目写入仍在等待
  s4: 回复条目已准备#65292;后续写入已放行
  s5: 回复写入可以继续
  [*] --> s0
  s0 --> s1: 原始期限到达
  s0 --> s2: 结束旧输入
  s0 --> s3: 用户正文同步到达
  s1 --> s4: 回调返回#65292;存活时补齐条目#65292;结束后跳过
  s1 --> s5: 继续回复写入
  s1 --> s2: 结束旧输入
  s3 --> s1: 原始期限到达
  s3 --> s4: 回调返回#65292;存活时补齐条目#65292;结束后跳过
  s3 --> s2: 结束旧输入
  s4 --> s5: 继续回复写入
  s4 --> s2: 结束旧输入
  s5 --> s2: 结束旧输入
```

## 如何验证

[覆盖映射](../skills/verify-session-execution/coverage.json) 与 [证明义务](../skills/verify-session-execution/requirements.md) 定义检查范围、源码哈希和假设；仓库不保存运行结果快照。

- 调度模型检查 Stop、固定批次、消费顺序、未知不重放和持久局部故障下的健康会话进展。
- 投递模型拆分两客户端的正文、RPC、凭据与激活到达，检查失败身份不复活，以及另一输入在永久分区下的进展。
- 回复模型检查回调不返回时的限时放行、存活回调补齐元数据、结束后取消迟到写入；进展不假定用户最终按 Stop。
- 真实 Effect/SQLite 回放包含局部写入失败、336 种 Stop/新输入/安全 epoch 交错、取消与投递选择。助手条目回放执行完整 MessageHandler 方法，检查超时后的作者、模型、关联输入和时间戳，以及结束后不重新打开条目。
- 负对照故意恢复扫描阻塞、丢恢复记录、越过启动检查、失败身份复活、等待死锁、迟到写入或超时误取消；校验器必须抓住这些错误。

```sh
python3 .agents/verification/state-machines/check.py --out /tmp/lody-session-check-new
```

新机器加 `--prepare-tools`，依赖安装与原始日志也保存在仓库外。锁文件固定传递依赖及完整性值，支持可复现的 `npm ci`。输出目录必须新建且位于仓库外，包含 `summary.json` 和逐项日志；PASS、FAIL、BLOCKED 分开记录。退出 0 表示本次所请求检查通过，1 表示当前性质失败，2 表示工具或映射无法完成。`expanded.py --source-only` 和 `--safety-only` 不能替代默认完整检查。

状态图保留 Mermaid 源文件及生成视图；pstack 原始报告写入外部目录。图会合并同类状态，不代表缩小证明边界。

## 证明与验收边界

这是同一系统的有限模型切片和真实代码边界回放，没有证明它们与整个生产实现完全对应，也没有证明无限设备/无限消息的所有时序。时间性质使用明确的弱公平假设；永久断网不能保证远程执行，整个数据库不可写时也不能安全授权未记录的输入。原始错误、待恢复记录和未知结果不能被删除来换取可用性。

回放没有运行实际多端 Loro/Roost 同步、签名/设备撤销、主机租约生产者、真实 Provider、完整 UI 或原生设备。迟到回复检查编译完整真实写入方法，但使用合成的 SQLite history 端口和诊断 span，不是 HistoryWriter 的完整验收。仓库缺少安装依赖，`pnpm check` 和 `pnpm format` 因缺少 tsgo/oxfmt 未完成；修改范围使用匹配版本的外部 Oxfmt，原生边界检查也通过外部 TypeScript 解析器执行。这些不替代全仓库 CI。

Session 的 `AGENTS.md` 字数上限由 1,200 调整为 1,280，完整保留新增输入确认和等待期限规则，并给后续维护留出空间。

## 技能来源

沿用 pstack 固定版本 `6b0300214a09fd6029cfb7077043125758cd1fd2` 的 [create-formal-verification-skill](https://github.com/cursor/plugins/blob/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack/skills/create-formal-verification-skill/SKILL.md)、[maintain-formal-verification-skill](https://github.com/cursor/plugins/blob/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack/skills/maintain-formal-verification-skill/SKILL.md) 与 [statechart](https://github.com/cursor/plugins/blob/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack/skills/statechart/SKILL.md)。只保留 [verify-session-execution](../skills/verify-session-execution/SKILL.md) 这一套系统技能。检查通过不表示已完成产品发布或设备验收。
