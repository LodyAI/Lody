# Lody 托管的长命令，以及推荐使用它的常驻提示

Status: implemented
Translation: current

[English](2026-11-16-managed-long-runs.md)

## 摘要

Agent 在后台启动耗时的构建或测试后结束本轮，Lody 便把会话当作空闲：空闲 GC 可能连同
Agent 启动的进程一起停掉 Agent，工作结束时也没有任何东西唤醒会话，用户只好输入“继续”来
追问。`lody_automation` 现在提供 `run` 命令：由 automation Host 持有进程，运行期间会话组
保持未安定，进程结束时排入一条带退出事实的续跑。原来宽泛的推荐已按
[提示范围决定](../simplification/2026-11-21-automation-guidance-scope.zh.md)收紧。
进程归属保持不变；agent 实际选择该能力的频率尚未测量。

## 决定

- run 是一个没有程序的 automation 等待项，复用 ledger 行、`list`、`show`、`cancel`、
  会话组待办查询和已有的 `external_event` 续跑，因此准入、Stop、权限和加密输入签名与其他
  续跑一致。
- `runtime/managed-runs.ts` 在 automation Host 的 Scope 中持有进程，而不是在启动它的检查里：
  取消检查不会杀掉 run，取消等待项会；关闭持有者会终止所有 run。持有者在 ledger 的 finalizer
  之后获取，所以 run 先于 ledger 关闭而停止。
- 启动在 spawn 之前持久化，并且只能认领一次。已启动但没有存活持有者的 run 会被报告为中断
  （附 pid），绝不重新启动：重跑可能重复 Agent 看不到的副作用。因此 Host 崩溃可能留下孤儿
  进程，续跑里会如实说明。
- 退出事实（结果类型、退出码或信号、耗时、日志路径、4 KiB 尾部、是否截断）由进程持有者
  记录，并让等待项立即到期；检查再把它们转成结果。结果中给出有界的命令字符串而非参数数组，
  以保持在 64 KiB 结果上限内。
- 环境是显式的：来自登录 shell 与守护进程的 `PATH`、home 与临时目录变量，以及调用方的
  `env`。不继承 Agent 的提供商凭据和会话 shell 环境。
- 提示遵循[范围决定](../simplification/2026-11-21-automation-guidance-scope.zh.md)：
  每轮提示不再推荐 Automation；帮助和 skill 只为必须在本轮结束后继续、并在退出时唤醒
  会话的工作说明 `run` 的用法。

## 备选方案

- 把空闲 GC 保护扩展到 Agent 启动的所有后台进程：未采用。Lody 看不到 Agent 内部，现有的
  原生活动保护只覆盖会报告它的 Agent，内存压力或重启仍会杀掉这些进程
  （[GC 与原生工作](../bug-fix/2026-10-18-gc-respects-native-agent-work.zh.md)）。
- 在条件里用 `ctx.exec` 运行命令：被否决。检查有 30 秒期限和 128 KiB 输出上限，且中断后
  可能再次运行（[外部检查](../../proposed/architecture/2026-10-28-automation-external-checks.zh.md)）。
- 继承会话完整的 shell 环境会把为 Agent 配置的提供商凭据一并传入，因此保留显式白名单。
- 重启被中断的 run：因上述副作用原因被否决。

## 影响

[提示不含流程的决定](../simplification/2026-11-11-agent-prompts-without-workflow.zh.md)
约束发给 agent 的文字，工具帮助中的使用条件按上述范围收紧。日志位于 `<data dir>/automations/runs/`，每个 run
上限 16 MiB，保留七天，在同一工作区启动另一个 run 时清理。

## 验证

`apps/cli/src/automations/workspace.test.ts`（"Managed runs"）使用真实进程：运行期间会话组
未安定、退出事实与排入的续跑、取消终止进程、持有者重启后报告中断且不二次启动、启动失败与
cwd 限制。`apps/cli/tests/session-execution-helpers.test.ts` 固定提示文字。Windows 进程树下
的行为以及对 agent 行为的影响尚未验证。
