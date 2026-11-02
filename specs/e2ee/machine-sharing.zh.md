# 加密机器共享

Status: approved · [approval](https://github.com/LodyAI/Lody/pull/2228) (merge `9b24c65ee`) · [记录](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-spec-approval.zh.md#机器共享)
Translation: current

[English](machine-sharing.md)

## 目标

在加密工作区里，成员默认只能在自己的机器上运行 agent。机器主人可以把机器按项目共享给团队。

## 谁能授权

- 只有机器主人能授权：在自己活跃的个人设备上签署完整的共享策略。
- 服务端、工作区 Owner/Admin 和其他成员都不能共享别人的机器，只能只读查看策略。
- 共享不写进成员账本。

## 默认值和开关

- 机器默认私有。
- 主人对每台机器、每个项目各有一个开关。打开项目会同时打开机器；关掉机器时保留项目选择。
- 共享给团队也包括之后加入的成员。Guest 和恢复设备永远不能在共享机器上运行任务。

## 执行

接收任务的机器只在当前策略共享了这台机器、以及任务用到的每个项目时，才运行成员的任务；否则拒绝，并给出具体原因，例如"机器未共享""项目未共享"。主人自己的任务不需要策略。

## 撤回

撤回后不能再启动新任务，也不能做任何需要授权的后续动作；已经在跑的命令不会被强制终止。

机器可以复用一次验证过的策略，时长不超过 15 分钟，所以撤回通常在这个窗口内生效。撤回生效没有严格上限：如果服务端一直扣住更新的策略，撤回就会被推迟。owner 已在 2026-10-28 接受这个风险，信任服务端不会这样做。

## 移除和重新配对

- 机器被移除后重新配对，就是新的*一代*（在账本里是一个全新身份）：默认私有，不继承旧授权，主人必须重新共享。
- 原子换钥（不移除、直接替换机器密钥）属于同一代，保留原有策略。

## 不在范围内

跨工作区共享；Owner/Admin 代替其他成员共享。

## 验收

来自 E2EE 可用性场景（不在本仓库中）：

- **⑫ 共享和撤回：** 已共享的机器和项目可用，未共享的被拒绝；撤回后新任务被拒绝。
- **⑬ 重新配对后的权限：** 主人重新共享之前一律拒绝；原子换钥后共享保持不变。

## 证据

不声称做过两名成员、两台机器的真实产品运行。

- 笔记：[机器共享](../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.zh.md)（细节、上限和攻击者模型）、[账本绑定](../../.agents/notes/proposed/architecture/2026-10-27-e2ee-machine-ledger-binding.zh.md)、[派生工作](../../.agents/notes/proposed/architecture/2026-10-31-e2ee-shared-member-derivation.zh.md)。
- PR：[#2014](https://github.com/LodyAI/Lody/pull/2014)、[#2018](https://github.com/LodyAI/Lody/pull/2018)、[#2033](https://github.com/LodyAI/Lody/pull/2033)、[#2144](https://github.com/LodyAI/Lody/pull/2144)、[#2147](https://github.com/LodyAI/Lody/pull/2147)、[#2171](https://github.com/LodyAI/Lody/pull/2171)、[#2175](https://github.com/LodyAI/Lody/pull/2175)。
- 测试：[core](../../packages/e2ee-core/test/machine-sharing.test.ts)、[host](../../packages/e2ee-machine-sharing/test/host.test.ts)、[可见性](../../packages/components/tests/encrypted-shared-machines.test.ts)、[CLI 执行](../../apps/cli/tests/session-execution-service.test.ts)。
