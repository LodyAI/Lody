# Agent Role 上下文消融

Status: implemented
Translation: current

[English](2026-09-09-agent-role-context-ablation.md)

## 摘要

把普通聊天开放给已授权机器之后，留下了重复的上下文分支与一个未被使用的「当前机器」参数。逐步
消融移除了这些分支与该参数（含调用方的 memo 依赖），同时保留本地项目与 worktree 的固定行为。
一次反向对照移除了「禁用条目插入守卫」，导致直接选择的回归测试失败，因此该守卫被恢复。本次清理
保留了 Role mention 行为，而不改变其权限或执行保证。

## 实验

这是 [PR #548](https://github.com/LodyAI/Lody/pull/548) 中
[可用性变更](../feature/2026-09-09-agent-role-mention-availability.md)的后续。每次正向实验都保留
上一次成功的删除；反向对照在最终验证前被恢复。测试 fixture 只因移除被删除的参数而改动，其行为
断言全部保留。

| 实验 | 结果 | 决策 |
| --- | --- | --- |
| 基线：六个 mention 套件 | 92 个测试通过 | 建立对照 |
| 移除返回默认授权作用域的 provider/GitHub 分支 | 25 个 Role 测试通过 | 删除：其结果与后续 return 相同 |
| 移除返回同一默认值的 GitHub 无 worktree 分支 | 25 个 Role 测试通过 | 删除：保留原有的仓库/worktree 条件用于固定 |
| 移除未被读取的 `currentMachineId`、调用方参数与 memo 依赖 | 92 个测试与组件类型检查通过 | 删除：所有调用方现在只从文件来源推导上下文 |
| 移除 `onMentionAdd` 中的禁用条目守卫 | 1 失败 20 通过；直接选择会插入被禁用的 Role | 恢复：该守卫保护可观察行为 |

另有一次针对真实上下文函数的前后对比，40 个用例全部通过：十种来源形态（plain、local、provider
组合以及 GitHub 仓库/worktree 组合），每种搭配四种「当前机器」输入。这在不依赖 fixture 参数改动
的前提下验证了上下文等价性。

仅凭测试通过并不能证明冗余：被保留的删除项还各自具备显式的等价性或「从未读取」证据。可用性解析、
排序、水合、展开与私有 Role 可见性均保持不变。本次不宣称任何时序或性能改进；移除 memo 依赖只是
避免了由一个函数并不读取的输入触发的重算。

## 验证

在最终恢复后的实现上，`pnpm check`、`pnpm format` 与 `pnpm run docs check` 均通过。组件：445 个
文件 / 3,318 个测试通过。本记录记录实验证据；既有 Spec 与约束规则的含义保持不变。
