# ACP 能力刷新缓存

Status: draft
Translation: current

[English](acp-capability-refresh-cache.md)

`machine/acp-capabilities-refresh` 请求询问某台机器上的 Agent 对外声明了什么能力。机器过去
只有一种回答方式：启动 Agent，取它的 `session/new` 响应，再把它关掉。在空闲机器上这是 Lody
最贵的一项周期性工作，而答案几乎从不与已经存好的那份不同。

## 机器的承诺

只有当已持久化的能力条目确实来自一次真实探测、且它的 `capabilitySourceVersion` 恰好等于当前
启动输入会产生的版本时，机器才用这份条目回答。该版本覆盖 Lody 能控制的一切：ACP adapter 构建
版本、实际安装的 managed runtime 版本、runtime override 路径、自定义启动命令，以及会改变 Agent
身份的环境变量值。其中任何一项变化都会 miss，因此缓存的答案不可能描述与 Lody 实际会运行的
二进制不同的东西。

机器无法为之算出键的条目永不复用。若期望版本取决于机器在未被要求时拒绝做的工作——比如某个
managed runtime 尚未安装——机器会去探测，而不是猜一个它将会安装的版本。超过有限寿命的条目会被
重新探测，因为 Agent 的斜杠命令、子 Agent 与模型权限可能在 Agent 自己的配置里变化，而 Lody
看不到那里。

对调用方而言，缓存的答案与探测得到的答案无法区分：它带着同样的 modes、models、config options、
commands 与能力条目，客户端按同样的方式写入自己的 Machine Flock 行。

## 哪些路径仍必须启动 Agent

缓存是默认路径，不是唯一路径。请求可以设置 `force` 来要求一次真实探测，以下路径都这样做：

- 设置页里由人按下的刷新——它存在的前提正是此人改了 Lody 在启动输入里看不到的东西。
- 认证成功后的能力校验——此时要回答的是新凭据到底能不能用、账号现在授予了什么。
- 引导流程的 Provider 测试与 provider setup 的校验——它们存在就是为了证明 Lody 刚安装的
  runtime 真的能启动。

`force` 在线路上默认缺席；机器把缺席当作"你可以用缓存回答"。不认识该字段的旧机器仍会探测，
对每一个强制刷新的调用方来说这是安全方向。

## 刷新不是定时任务

启动期的能力发现是每个客户端一遍，并且按 config 而不是按"一遍"来记账，因此一遍被打断后重启
——失去 presence 正是这种情况——不会重新探测已经回答过的 config。失败的 config 仍可重试。
客户端不得把重连变成周期性探测；本协议不提供任何刷新间隔。

## 证据

`packages/shared/tests/ai-capability-cache.test.ts`（复用、过期、版本不可知、provenance）、
`packages/shared/tests/local-session-control.test.ts` 与
`packages/loro-streams-rpc/tests/machine-rpc-server.test.ts`（两条传输上的 `force` 字段）、
`apps/cli/tests/session-execution-service.test.ts`（命中缓存不启动 Agent；override 变化、
过期与 `force` 都会启动）、`apps/cli/tests/agent-setting.test.ts`（期望版本等于启动会打上的
版本，且 managed runtime 缺失时不可得）、
`packages/components/tests/startup-acp-capabilities-refresh.test.ts`（被打断的一遍不会重复
探测已回答的 config）。改动前的实测行为记录在
`.agents/notes/implemented/bug-fix/2026-09-16-acp-capability-refresh-cache.md`。
Draft 待人工评审；测试不构成批准。
