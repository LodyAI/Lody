# 会话自动交付

Status: draft
Translation: current

[English](session-auto-delivery.md)

## 场景

用户和 agent 在对话中商定了修法。从这时起，用户希望剩下的例行步骤不再需要自己：开
PR、等 CI、修失败的检查、解决冲突，以及在用户选择时于 CI 通过后合入。现在每一步都要
点按钮或打字，步骤之间的等待都花在盯 CI 上。

## 决定

自动交付是每个会话的一项自动化设置，默认关闭。它在对话中途开启，从不在新建会话时开
启。三个入口共用同一个设置：信息栏的“自动交付”动作、会话菜单里的自动化设置，以及用
户在对话里提出要求时 agent 通过 `lody_automation configure` 自行开启。开启时选择 Lody
可以请求哪些步骤：修 CI、解冲突、CI 通过后合入。合入默认不选。设置只覆盖会话当前的
PR，该 PR 合入后自动关闭。

本机 Host 根据 PR 轮询器对当前 PR 的观察决定每一步。它给 agent 发送与对应信息栏按钮
相同的请求，前面加一行来源说明，经由普通的自动化队列和会话准入。请求要等会话组空闲
才发出；PR 已经变化则作废。包括合入在内的所有 GitHub 改动都由 agent 用自己的 `gh`
完成，守护进程只观察。

## 保证

- 用户没有为这个会话开启自动交付时，不会发出任何请求；只有用户选择了合入才会请求合入。
- 每次开启内，每类修复最多请求三次，每个 head 提交最多请求一次合入。次数用完、需要审查
  或需要更新分支、PR 被关闭或是草稿、请求后没有推送新提交、合入请求后仍未合入，都会停
  下，并在对话和侧边栏“需要处理”分组里显示原因。停下后不会自行重试。
- 会话 Stop 按现有规则阻塞待发请求，只有用户能恢复。
- 不支持在多个仓库都有 PR 的会话，也不支持加密工作区（那里不运行 PR 轮询器）。加密
  工作区直接拒绝该设置，而不是接受一个无法执行的设置。

## 未决问题

- 加密工作区支持取决于在本机为其运行 PR 观察。
- 项目默认值和 PR 讲解选项留待以后。

## 证据

- 实现：`apps/cli/src/automations/policies/delivery.ts`、
  `apps/cli/src/automations/policies/session.ts`、自动化
  [README](../apps/cli/src/automations/README.md#built-in-session-behavior)。
- 界面：`packages/components/src/components/sessions/session-auto-delivery.tsx`。
- 理由：[决策笔记](../.agents/notes/proposed/feature/2026-11-16-session-auto-delivery.zh.md)。
- 验证：`apps/cli/src/automations/automations.test.ts` 中的合成账本测试覆盖请求顺序、
  次数上限、守卫和请求文字。尚未在真实仓库或 GitHub 账号上运行。
