# 移动端轮次页脚在运行时开始计时

Status: implemented
Translation: current

[English](2026-09-14-mobile-live-turn-duration.md)

## 摘要

移动端的 assistant 轮次操作栏在最前面预留了一个时长槽位，它的宽度是有承重作用的
——正是它把复制和 fork 按钮推出会话抽屉左边缘的返回滑动条——但这个槽位此前只在轮次
结束后才会被填上。于是 agent 还在工作时，这条操作栏就是两个图标旁边挨着一段显眼的
空白，而用户此刻唯一会问的问题（这一轮跑了多久了）在屏幕上没有答案。现在这个槽位
会从该轮次自己的 `timestamp` 开始每秒递增，而这正是已完成标签所使用的同一个锚点，
因此没有等待过权限的轮次在结束时是停住而不是跳变——等待过权限的轮次会按等待时长向下
跳一次，因为执行机只在轮次结束时才写入 `permissionWaitMs`。计时被限制在一个叶子组件里，只有它订阅共享的
`useStableNow`，所以一个进行中的轮次只让一个 span 重渲染，而不是让所有可见的
页脚都重渲染。值得点明的限制是：「live」的定义是「对话里最后一个 `finished !== true`
的 assistant 轮次」，这是一个结构性判断，不是活性探测——机器异常退出、没有写
`finished` 的轮次之所以最终不会一直数下去，只是因为会有新的轮次把它顶掉。

## 决策

### 锚点是轮次，不是会话

「agent 工作了多久」最直觉的数据源是会话 presence，毕竟所有工作指示器都靠它驱动。
但在这里它是错的数据源：`LodySessionPresenceState` 只报告会话**是否**活跃以及状态
类型，不携带起始时刻——`updatedAt` 是 30 秒心跳。基于 presence 的计时必须用「客户端
观察到的跃迁」加上 `SessionMeta.lastRunningSeen` 去重建起点，而 `lastRunningSeen`
在每次非 idle 跃迁时都会被重写，所以一次权限往返就会让它重新开始。

轮次本身已经带着正确的数字。`resolveSessionHistoryDurationMs` 把已完成标签定义为
`(endedAt - timestamp) - permissionWaitMs`；`resolveLiveSessionHistoryDurationMs`
就是把 `endedAt` 换成 `now` 的同一个表达式。这个相等关系正是重点：live 与 finished
是同一个量在两个时刻的观测，所以轮次结束时发生的是「停表」，不是「修正」。

### 权限等待是 live 路径唯一看不见的那一项

上面的相等关系对 `timestamp` 这一项成立，对 `permissionWaitMs` 则不成立。执行机在
每个权限请求解决时把等待时长累加进自己的临时状态
（`apps/cli/src/lib/session-transient-store.ts`），只有通过 `finish-assistant`
动作才会把它写到历史条目上（`message-handler.ts`）。所以一个进行中的条目上根本没有
`permissionWaitMs`，live 标签会把用户自己的思考时间也算进去，到轮次结束时再按整段
等待时长**向下跳**一次。对于没有权限卡片的轮次——也就是常见情况，以及所有自动批准
模式下的情况——两者完全一致。

客户端自行修补都不成立。客户端能看到「某个请求尚未被回答」（`tool_call` 的
`permissionRequest` 没有 `outcome`），但看不到等待是何时开始的：
`PermissionRequestInfoSchema` 不带时间戳。靠观察去累计暂停时长还有第二个问题——页脚
位于虚拟列表中，把进行中的轮次滚出视口就会卸载观察者并丢掉累计值。要真正解决，只能
由执行机把 live 的等待状态发布出来：在每个请求解决时写入累计的 `permissionWaitMs`，
外加进行中等待的起始时刻，客户端才能不依赖本地状态把两者都扣掉。那是 schema 加 CLI
的改动，本次刻意没有做。

唯一刻意的偏差：起点在未来时（机器时钟快了）钳到 `0s`，而不像已完成那版返回 null。
反正槽位都会预留，而这次改动的全部理由就是——一个空着的预留槽位读起来像布局 bug。

### 哪个轮次算 live

`isLive` 在构建行的地方计算，为
`isLastAssistantMessage && message.finished !== true`，随页脚行一起传下去。
只看 `finished !== true` 是不够的：被中断或被遗弃的轮次会永远以未完成的状态留在历史
里，那样每一个这样的轮次都会并排往上数。要求它同时是最后一个 assistant 轮次，把范围
收敛到至多一行；而行缓存本来就会在 `isLastAssistantMessage` 变化时失效，不需要新造
一套失效机制。

这是结构性判断，不是活性检查。机器在轮次中途挂掉的会话会留下一个未完成的最后轮次，
它会一直数到被什么东西顶掉为止。在页脚里读 presence 可以修掉这个场景，代价是在整个
对话中挂载数量最多的组件里增加一个按轮次的 atom 订阅——为了一个用户看一眼输入框就能
判断的状态，这笔交易不划算。

### 为什么要单独做成叶子组件

`useStableNow` 是共享定时器：所有订阅者共用一个 interval，一次 tick 只重渲染订阅了
它的部分。如果在 `AssistantTurnFooter` 里调用，就会让每个可见轮次的页脚在每次 tick
都重渲染，包括那些没有任何东西需要更新的已完成轮次。`LiveTurnDurationLabel` 只在
live 轮次上挂载，于是订阅恰好只在真的有东西要数的时候存在。

### 采样频率高于显示频率

标签一秒变一次，但以 300ms 采样，因为「每秒变一次」和「踩在整秒上变」在这里不是一回事。
共享定时器的相位由第一个挂载的订阅者决定，与这个轮次何时开始毫无关系，所以 1s 的采样
可能落在已过秒数内的任何位置。那样数字会在一个看起来随意的时刻跳变，更糟的是可能滞后
接近整整一秒：一个已经跑了 5.4 秒的轮次会一直显示 `5s`，直到采样触发，而那可能已经比
应该显示 `6s` 的时刻晚了 600ms。

用 300ms 采样把这个误差压到 300ms 以内，同时不改变渲染内容：多出来的那些采样格式化出
的字符串完全相同，React 比对后不会写 DOM。代价是每秒多两次叶子渲染，作用在一个 span
上，且只在有轮次在跑时存在。把一个私有 `setTimeout` 锚在轮次自己的起点上可以做到精确
而不只是有界，但那要用「每个 live 轮次一个定时器」换掉共享定时器，并把 `useStableNow`
已经处理好的漂移问题重新捡回来；300ms 已经近到差别不可观测。

`SessionChatActionContext` 现在被导出。未完成轮次的操作栏以「存在 copy-context 处理
函数」为前提，所以这个前提是被测状态的一部分，而不是围绕它的脚手架；测试通过它驱动
真实组件。

## 验证

`tests/session-history-duration.test.ts` 固定了 live 解析器，包括它在同一轮次上与
已完成版本取值一致，以及对未来起点的钳制。`tests/assistant-turn-action-inset.test.ts`
在 fake timers 下渲染移动端页脚：live 轮次从 `Worked for 5s` 推进到 `Worked for 7s`；
起点与定时器相位错开 400ms 的轮次，在已过 5.9 秒时仍显示 `5s`、在 6.1 秒时已显示
`6s`；已完成轮次在五秒内保持记录值不变；非 live 的未完成轮次保持槽位为空且预留
`min-width` 不变。把 live 分支摘掉后只有第一条失败；把采样周期改回 1 秒则只有相位
那条失败。

`MobileTurnDurationSlot.stories.tsx` 在手机尺寸的框里渲染两种状态；在浏览器中驱动
live story，相隔三秒分别读到 `Worked for 48s` 与 `Worked for 51s`。

`tests/chat-virtual-rows-identity.test.ts` 固定了 memo：当新轮次顶掉一个被遗弃的未完成
轮次时，被顶掉那个页脚重建出来的行**不得**与已挂载的行比较相等。如果这个比较里不含
`isLive`，memo 会跳过重渲染，旧标签就会和新轮次的标签并排继续数下去，从而击穿「只允许
一行」的约束；测试正是在这种状态下失败。

未验证：设备休眠/恢复时的表现——此时 interval 会被节流，下一次 tick 会把数值纠正过来，
但中间那一帧没有在真机上观察过。上面描述的权限等待向下跳是一个已知且未修的缺口，不是
验证限制。
