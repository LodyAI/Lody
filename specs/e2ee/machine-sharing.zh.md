# 加密机器共享

Status: draft
Translation: current

[English](machine-sharing.md)

## 问题和目标

在加密工作区里，成员默认只能在自己的机器上运行 agent。机器主人可以把这台机器共享给团队，按项目逐个开放。共享必须由主人本人决定，服务端不能代为授权。

## 谁能授权

- 只有机器主人能共享。主人在自己当前活跃的个人设备（比如桌面端）上签署一份完整策略，即"共享了哪些内容"的完整清单。机器、恢复设备或已撤销的设备都不能签。
- 服务端、工作区 Owner 或 Admin、其他成员都不能授予或修改别人机器的共享。其他成员只能只读查看策略。
- 共享不写进成员账本（记录成员和设备的签名账本）。开关某个项目不是成员变更。

## 默认值和开关

- 每台机器默认私有。
- 主人对每台机器有一个开关，对机器上的每个项目各有一个开关。打开项目会同时打开它所在的机器。
- 关掉机器时保留项目选择，重新打开就恢复原样。
- 共享给团队也包括之后加入的成员。Guest 和恢复设备永远不能在共享机器上运行任务。

## 执行时的检查

由接收任务的机器做决定。启动任务前、以及任务的每个后续动作前，它都检查：请求者是当前成员，并且主人当前的策略共享了这台机器和任务能触及的**每一个**本地项目。未共享的一律拒绝，并给出精确原因，例如"机器未共享""项目未共享""策略不可用"。主人自己的任务不需要策略。

只打开机器开关，就允许不涉及任何已登记项目的任务（比如普通聊天）。项目开关决定成员可以在哪里开始工作，它不是文件系统沙箱。

## 撤回

主人关闭共享、且机器获知新策略后：

- 成员的新任务被拒绝；
- 正在跑的任务不能再执行任何需要授权的后续动作；
- 机器立即丢弃缓存的授权。

已经知道撤回的发送方会拒绝发送，并保留草稿。

**信任边界。** 机器会复用一次经过验证的策略读取，时长不超过 15 分钟，因此撤回通常在这个窗口内生效。签名能发现伪造或回滚的策略，但无法证明拿到的是最新策略。如果服务端一直扣住更新的策略不下发，撤回就可能被无限期推迟。owner 已在 2026-10-28 接受这个风险：信任服务端不会持续扣住更新的策略，MVP 不额外引入新鲜度证明。

## 移除和重新加入

- 移除机器会结束它当前的*一代*（这台机器在账本中一段连续的身份）。之后重新配对，即使名字和主人都相同，也是新的一代：默认私有，不继承任何旧授权，主人必须重新明确共享。
- 原子换钥（不移除、一步替换机器密钥）属于同一代，保留原有策略。

## 不在范围内

- 跨工作区共享。
- Owner 或 Admin 代替其他成员共享其机器。
- 共享成员的任务在*另一台*机器上派生的工作，见[派生工作](../../.agents/notes/proposed/architecture/2026-10-31-e2ee-shared-member-derivation.zh.md)。
- 同一台机器内部的文件系统隔离。

## 待决问题

当前实现在撤回时不会强制终止已经在运行的命令，只阻止新启动和后续需要授权的动作。请 owner 确认"正在跑的任务会停止"是否就是这个含义，还是要求强制终止。

## 验收

来自 E2EE 可用性场景（场景清单不在本仓库中）：

- **⑫ 共享和撤回。** 成员能使用已共享的机器和项目，在未共享的项目上被拒绝；撤回后新任务被拒绝。
- **⑬ 机器重新配对后的权限。** 移除并重新配对后，成员被拒绝，直到主人重新共享；原子换钥后共享保持不变。

## 证据

预期行为以本 Spec 为准。下面列出已检查的实现和已执行的测试；这里不声称做过两名成员、两台机器的真实产品运行。

- 笔记：[机器共享](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.zh.md)、[账本绑定](../../.agents/notes/proposed/architecture/2026-10-27-e2ee-machine-ledger-binding.zh.md)、[派生工作](../../.agents/notes/proposed/architecture/2026-10-31-e2ee-shared-member-derivation.zh.md)、[配对日志](../../.agents/notes/proposed/architecture/2026-10-26-e2ee-machine-pairing-journal.zh.md)；[基础契约增量](../e2ee-foundations.zh.md)。
- PR：[#2014](https://github.com/LodyAI/Lody/pull/2014)、[#2018](https://github.com/LodyAI/Lody/pull/2018)、[#2033](https://github.com/LodyAI/Lody/pull/2033)、[#2144](https://github.com/LodyAI/Lody/pull/2144)、[#2147](https://github.com/LodyAI/Lody/pull/2147)、[#2171](https://github.com/LodyAI/Lody/pull/2171)、[#2175](https://github.com/LodyAI/Lody/pull/2175)。
- 测试：[core](../../packages/e2ee-core/test/machine-sharing.test.ts)、[host](../../packages/e2ee-machine-sharing/test/host.test.ts)、[成员可见性](../../packages/components/tests/encrypted-shared-machines.test.ts)、[CLI 执行](../../apps/cli/tests/session-execution-service.test.ts)。
