# ACP 能力刷新缓存

Status: draft
Translation: current

[English](acp-capability-refresh-cache.md)

`machine/acp-capabilities-refresh` 请求询问某台机器上的 Agent 对外声明了什么能力。机器过去
只有一种回答方式：启动 Agent，取它的 `session/new` 响应，再把它关掉。在空闲机器上这是 Lody
最贵的一项周期性工作，而答案几乎从不与已经存好的那份不同。

## 机器的承诺

只有以下条件全部成立时，机器才用已持久化的能力条目回答：

- 该条目来自一次真实探测。
- 它的 `capabilitySourceVersion` 恰好等于当前启动输入会产生的版本。该版本标识的是二进制：ACP
  adapter 构建版本、实际安装的 managed runtime 版本、runtime override 路径或扩展集合、自定义
  启动命令。
- 机器自己记录过：该条目正是由当前这组启动输入产生的，**包括 config 的环境变量**。source
  version 承载不了这一点：对 custom 与 registry config，以及除 DeepSeek endpoint 之外的所有
  builtin，它根本不依赖环境变量，而 token 或 endpoint 的变化却可能改变 Agent 声明的能力。

任何启动输入的变化——二进制、override、命令或任一环境变量值——都会 miss。

这份启动输入记录有意只保存在应答机器的内存里。条目本身存在 Machine Flock 文档中，而该文档会
同步上云；环境变量值及其任何派生值都不得写入那里——低熵 token 的哈希可以被穷举还原。代价是：
机器重启后无法把已有条目归属到当前输入，因此每个 config 会先探测一次，之后才再次信任缓存。

机器无法为之算出键的条目永不复用。若期望版本取决于机器在未被要求时拒绝做的工作——比如某个
managed runtime 尚未安装——机器会去探测，而不是猜一个它将会安装的版本。超过有限寿命的条目会被
重新探测，因为 Agent 的斜杠命令、子 Agent 与模型权限可能在 Agent 自己的配置里变化，而 Lody
看不到那里。

寿命从探测或新建会话最后一次确认该条目时算起，而不是从其内容最后一次变化时算起。写入方仍会
跳过重写未变的内容——每次写入都意味着一次 Flock 写入、flush 与同步——但只在条目年龄小于寿命
一半时跳过；超过之后，一次内容未变的确认也会为它续期。若不续期，内容从不变化的条目会在过期
一次之后，对此后每一个请求都 miss。

对调用方而言，缓存的答案与探测得到的答案无法区分：它带着同样的 modes、models、config options、
commands 与能力条目，客户端按同样的方式写入自己的 Machine Flock 行。

## 哪些路径仍必须启动 Agent

缓存是默认路径，不是唯一路径。请求可以设置 `force` 来要求一次真实探测，凡是由人或安装流程
发起的请求都这样做：

- 设置页里由人按下的刷新——它存在的前提正是此人改了 Lody 在启动输入里看不到的东西。
- `refresh-capabilities` CLI 命令——理由相同。
- 认证成功后的能力校验——此时要回答的是新凭据到底能不能用、账号现在授予了什么。
- 引导流程的 Provider 测试与 provider setup 的校验——它们存在就是为了证明 Lody 刚安装的
  runtime 真的能启动。

会用缓存回答的机器与认识 `force` 的机器是同一台机器，因此一个协商能力同时覆盖两者：客户端
只向声明了 `acpCapabilityRefreshCache` 的机器发送 `force`，其余情况完全省略该字段。省略本身
就是全部机制，而不是形式——不具备该能力的机器会严格解析这个请求，收到未声明字段会把它丢弃或
拒绝，强制刷新的调用方只会等到一个超时而不是一次刷新。而从未声明该能力的机器也本就没有缓存
可供退出，所以省略字段照样给了该调用方它要的那次探测。

在确实支持该字段的机器上，`force` 同样默认缺席，此时缺席意味着"你可以用缓存回答"。两条传输
以同样方式携带该字段，因为桌面应用与机器 daemon 各自独立升级，任何一侧都可能是较新的那一侧。

## 刷新不是定时任务

启动期的能力发现是每个客户端一遍，并且按 config 而不是按"一遍"来记账，因此一遍被打断后重启
——失去 presence 正是这种情况——不会重新探测已经回答过的 config。失败的 config 仍可重试。
客户端不得把重连变成周期性探测；本协议不提供任何刷新间隔。

## 证据

`packages/shared/tests/ai-capability-cache.test.ts`（复用、过期、版本不可知、provenance）、
`packages/shared/tests/local-session-control.test.ts` 与
`packages/loro-streams-rpc/tests/machine-rpc-server.test.ts`（两条传输上的 `force` 字段）、
`packages/shared/tests/machine-protocol-capabilities.test.ts` 与
`packages/loro-streams-rpc/tests/loro-streams-rpc.test.ts`（协商：把实际发出的 payload 对照
一份由当前 schema 派生出的上一代 schema 校验，两条传输都覆盖）、
`apps/cli/tests/session-execution-service.test.ts`，经由真实的 `MachineDocument`（命中缓存
不启动 Agent；override 变化、过期、环境变量编辑、重启与 `force` 都会启动；过期条目被探测出相同
内容后会再次由缓存回答；年轻条目不会被重写；持久化的行里不含任何环境变量值或摘要前缀）、
`apps/cli/src/lib/loro/machine-document-capabilities.test.ts`（续期阈值）、`apps/cli/tests/agent-setting.test.ts`（期望版本等于启动会打上的
版本，且 managed runtime 缺失时不可得）、
`packages/components/tests/startup-acp-capabilities-refresh.test.ts`（被打断的一遍不会重复
探测已回答的 config）。改动前的实测行为记录在
`.agents/notes/implemented/bug-fix/2026-09-16-acp-capability-refresh-cache.md`。
Draft 待人工评审；测试不构成批准。
