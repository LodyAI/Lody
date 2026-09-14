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
因此轮次结束时数字是停住，而不是跳变。计时被限制在一个叶子组件里，只有它订阅共享的
`useStableNow(1000)`，所以一个进行中的轮次只让一个 span 重渲染，而不是让所有可见的
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
是同一个量在两个时刻的观测，所以轮次结束时发生的是「停表」，不是「修正」。它还顺带
继承了扣除权限等待这件事，而基于 presence 的锚点根本无法表达这一点。

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

`useStableNow(1000)` 是共享定时器：所有订阅者共用一个 interval，一次 tick 只重渲染
订阅了它的部分。如果在 `AssistantTurnFooter` 里调用，就会让每个可见轮次的页脚都每秒
重渲染一次，包括那些没有任何东西需要更新的已完成轮次。`LiveTurnDurationLabel` 只在
live 轮次上挂载，于是订阅恰好只在真的有东西要数的时候存在。

`SessionChatActionContext` 现在被导出。未完成轮次的操作栏以「存在 copy-context 处理
函数」为前提，所以这个前提是被测状态的一部分，而不是围绕它的脚手架；测试通过它驱动
真实组件。

## 验证

`tests/session-history-duration.test.ts` 固定了 live 解析器，包括它在同一轮次上与
已完成版本取值一致，以及对未来起点的钳制。`tests/assistant-turn-action-inset.test.ts`
在 fake timers 下渲染移动端页脚：live 轮次从 `Worked for 5s` 推进到 `Worked for 7s`，
已完成轮次在五秒内保持记录值不变，非 live 的未完成轮次保持槽位为空且预留 `min-width`
不变。把 live 分支摘掉后，只有第一条会失败。

`MobileTurnDurationSlot.stories.tsx` 在手机尺寸的框里渲染两种状态；在浏览器中驱动
live story，相隔三秒分别读到 `Worked for 48s` 与 `Worked for 51s`。

未验证：设备休眠/恢复时的表现——此时 interval 会被节流，下一次 tick 会把数值纠正过来，
但中间那一帧没有在真机上观察过。
