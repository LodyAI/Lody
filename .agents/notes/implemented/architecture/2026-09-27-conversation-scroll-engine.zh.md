# 对话滚动引擎：单一程序化写入方、阅读锚点、已提交布局

Status: implemented
Translation: current

[English](2026-09-27-conversation-scroll-engine.md)

## 摘要

打开对话时，整个面板仍可能保持空白，直到读者点击"回到最新"；此前这一区域已经修过七次。
Virtua fork 和 `use-sticky-scroll` 两个状态机都会写 `scrollTop`，彼此只通过异步 scroll 事件感知对方；
位置按像素存储，补偿按增量施加，一个 fail-closed 的门在两者一致之前一直隐藏面板。
本提案用一个对话滚动引擎取而代之。它是唯一的程序化写入方并拥有滚动范围；
它的状态是读者意图，用语义阅读锚点表达，写出的每个位置都由锚点推导。
在最小行高（外加一个有界的固定行豁免集）和"行布局与位置无关"两个前提下，
它在有限次提交内覆盖视口，从不等待事件，也从不隐藏面板。它通过列表 handle 接缝、
消费方通过列表 handle（`ConversationListHandle`）使用它。引擎已实现，并且是唯一的对话滚动实现：负责人于 2026-09-27
决定直接上线，不设开关、不做 dogfood，并删除了 Virtua 路径和 `useStickyScroll`。按浏览器顺序投递事件的 jsdom 复现
确认了旧路径的停滞（缓存阅读偏移叠加视口上方超出 overscan 的展开）；在真实 Chromium 中，引擎在打开、滚轮滚动和切换
3,000 turn 对话时每一帧都有覆盖。上线时尚未验证：桌面应用、iOS 真机和长对话性能剖析。
接受的代价只涉及私有移动端 app 的 iOS：在所有已发布的 iOS 版本上，fling 期间的布局补偿会结束这次 fling；
开源桌面端运行在 Chromium 上，不受影响。评审：2026-09-27，Codex（GPT-6 Astra）五轮，Claude 会话 `dfd4a856` 三轮。

## 问题

### 代码层面的停滞路径

以下路径通过阅读代码，以及调用真实 Virtua store 和 `getInitialScrollLayoutBlocker` 的内存探针确认；
没有浏览器或桌面端捕获。每条路径中，面板只有在没有其他 Virtua 状态提交、也没有滚动到不同 offset 时
才会保持空白；空闲对话满足这一条件。

共同起点：会话带着缓存的像素偏移（`type: 'offset'`）重新打开，模式为 `free`。揭示门
（`view.tsx`：`initialWindowReady && initialScrollRestored`）隐藏视口。"回到最新"按钮在视口之外，
仍可点击；它的出现只说明模式不是 sticky，本身不能证明原因。

- **A. 写回之后没有触发揭示检查。**首次测量或视口上方的 keyed 插入产生 Virtua jump，其 layout effect 调用
  `scrollBy(jump)`（`observer.ts` `_fixScrollJump`）。随之而来的观察者投递调用 `settleInitialLayout`，
  它写回缓存偏移并*不检查布局直接返回*（`cached-offset-reapplied` 分支）。写入值等于 Virtua 仍持有的
  offset，所以 `writeScrollTop` 不派发任何事件；原生事件报告同一 offset，`ACTION_SCROLL` 忽略它，
  `onScroll` 不触发；`handleNativeScroll` 把它当作自身写入。再没有任何东西重新执行检查。
- **B. 渲染范围被冻结。**`_flushedJump` 非零时 `$getRange` 返回上一次的范围；同 offset 的
  `ACTION_SCROLL` 在清除它之前就返回。下一次零 jump 的 Virtua 提交会解除冻结。生产环境 800px overscan
  下，只有较大的展开才会让视口失去覆盖：一行变成十四行时得到 `target-unmounted`。
- **C. 已揭示但为空。**阅读模式下 blocker 只检查视口底边所在行是否已挂载且已测量。一个无 overscan
  的探针对"与视口相交行数为零"的范围给出了揭示。

"回到最新"能恢复 A 和 B：它写入一个不同的 `scrollTop`，Virtua 收到 offset 不同的事件，follow 模式的检查通过。

**更正（2026-09-27，来自 jsdom 复现）。**单独的 A 会自愈：之后的某次几何投递会重新执行揭示检查，只要范围仍覆盖视口就能通过。
持续空白需要两者同时出现：A 的写回让 Virtua 收到它已持有 offset 的 scroll 事件，从而保留 B 的冻结范围；
当跳变超出 overscan 时，冻结范围不覆盖屏幕上的任何行，揭示检查永远失败，也没有别的东西再执行它
（`tests/sticky-scroll-open-stall.test.tsx`）。

**这一症状排除了水合窗口路径。**揭示门是合取条件。若停滞的是 `initialWindowReady`，点"回到最新"只会进入
follow 模式，视口仍然隐藏。因此"回到最新能恢复"只与 `initialScrollRestored` 停滞一致，范围收窄到 A 和 B。

**现状可能已存在第三个写入方（未在浏览器验证）。**视口没有声明 `overflow-anchor`，只有 Virtua 自己的容器设置了
`none`（`Virtualizer.tsx`）。视口内与该容器同级的回复空间 spacer 和 `MessageSelectionOverlay` 仍可成为锚点候选；
spacer 可见时若上方内容变高，Chromium 可能自行调整 `scrollTop`。

### 早先的修复为何没有挡住它

相关修复：#674、#695、#856、#888、#896、#940、#945。

- **风险被点名过，但只针对揭示之后。**[keyed fork 笔记](../../implemented/architecture/2026-09-24-virtua-keyed-fork.zh.md)
  否决了持续的第二写入方，因为它"会撤销一个 scroll 事件尚未到达的程序化跳变"。揭示前的重放
  （#896，被带入 #940）正是这种写入方，#945 没有重新审视它；#940 与 #945 同日合并。
- **没有测试把相互作用的部分放在一起。**hook 测试的 mock handle 把 `scrollOffset` 映射到 DOM，
  那里不存在 Virtua 的待处理 jump 状态；`packages/virtua/tests` 没有外部写入方；
  `sticky-scroll-virtua.test.tsx` 覆盖底部导航和 resize（含非跟随读者）。没有测试组合"揭示前 keyed 变化、
  自身写入、迟到或缺失的 scroll 事件"。
- **真实浏览器回归测试到不了这些路径，也不在 CI 中运行。**它的缓存偏移用例一次性放出静态列表；
  没有 workflow 运行 `packages/components/tests/e2e` 或构建 Storybook。
- **每次修复清掉一个 blocker，没有人证明终止性。**揭示需要八个条件一致，任何一次漏掉的唤醒都会变成
  输入无法触达的空白面板。滚动诊断只在开发构建中记录；#896 笔记说明原始运行时状态已经丢失。

### 结构性原因

| 原因 | 历史上的后果 |
| --- | --- |
| 两个程序化写入方（加上浏览器锚定可能是三个），各自保存 offset 副本并通过 scroll 事件同步 | 一方取消另一方的等待状态（A、B）；`scrollToIndex` 请求 150ms 后失效（#896）；大纲跳转需要修正循环 |
| 补偿按增量施加 | 0.49 版叠加补偿互相抹掉（打过补丁）；被撤销的增量冻结了范围 |
| 位置按像素存储 | 尺寸变化后缓存偏移对应别的内容，于是需要第二写入方反复重放 |
| 隐藏且不接收输入的视口上的 fail-closed 门，其活性依赖事件 | 每次漏掉的唤醒都变成空白面板（A、B）；门的检查可能在空范围上通过（C） |

## 不变量

均在提交边界、针对已提交的 DOM 检查。

- **I1 单一程序化写入方，单一范围拥有者。**只有引擎适配器给对话视口的 `scrollTop` 赋值并设置其滚动范围；
  视口本身关闭浏览器滚动锚定。浏览器仍会因读者输入、视口增长、焦点和选区自动滚动而移动位置；
  这些是观测，不是写入。
- **I2 单一已提交快照。**每个 cycle 以一个快照结束：`{ sourceGeneration, geometryRevision,
  scrollTop（读回）, viewportHeight, extent, contentEnd }`，其中 `geometryRevision` 等于已提交到 DOM 的
  revision。所有消费方（大纲、可见 turn 上报、选区、水合窗口、缓存捕获）都通过列表 handle、经由这个快照
  换算坐标，不保存自己的副本。
- **I3 不依赖事件的覆盖。**cycle 结束时，已提交的行覆盖 `[S, S + viewportHeight]` 的内容部分，
  其中 `S` 是该 cycle 接受进 `lastObserved` 的读回位置。padding、回复空间，以及合法的空对话或短对话不需要行。
  这在最多两遍、每遍最多两次补充提交内成立，不使用定时器（见覆盖引理）。尚未覆盖的位置从不被记为已接受，
  因此由它的变化排队的 scroll 事件必然启动一个覆盖它的 cycle。
- **I4 测量在构造上是最新的。**观察者条目只有在投递时该行的内容 revision 等于当前 revision，才被采纳为测量，
  此时 commit 0 直接携带新几何；否则该行只被标脏，在提交之后读取。同一意图对同一已提交几何的解析是确定的。
- **I5 可达时锚点稳定。**阅读模式下，只要锚点可解析且其目标位于 `[0, maxScrollTop]`，
  锚点的屏幕位置在列表与尺寸变化中不变；否则适用文中规定的回退。与补偿同时发生的读者移动叠加保留。
  **滚动条拖动进行中除外**：滑块映射的是绝对 offset，会覆盖补偿，锚点必然漂移，与现状相同。
- **I6 贴底。**follow 模式下每个 cycle 后 `scrollTop = maxScrollTop`；短于视口的对话顶部对齐。
- **I7 首帧可读。**首个绘制帧满足 I3；锚点可解析且可达时精确，否则可读，从不隐藏。
- **I8 不推断意图。**几何变化从不释放或重新启用 follow；唯一由几何驱动的模式变化，是回复填满预留空间时
  规定好的 `sent` → `follow` 交接。读者的移动到达末尾时重新启用 follow：向下滚动到距当前底部 4px 以内，
  或一段向下的滚动序列停在（`scrollend`）该序列进行期间范围曾有过的某个底部。

## 提案

### 职责

| 部分 | 负责 | 不做 |
| --- | --- | --- |
| 引擎核心（纯 TypeScript） | 意图、位移分类、锚点解析、范围规划、回复空间、glide 进度、诊断 | 读写 DOM、使用定时器 |
| 几何（引擎自有） | 按行 key 与布局版本键控的尺寸与偏移；P2 从 fork 的 keyed list layout 迁入 | 滚动、订阅事件 |
| DOM 适配器（一个 hook） | 提交协议、DOM 采样、观察者条目采纳、两种形式的唯一写入、命令式设置范围、标脏 | 决定位置 |
| React 列表 | 以绝对定位和稳定的 React key 渲染规划好的范围 | 滚动 |
| 消费方 | 一律通过 `ConversationListHandle`：命令、读取快照、必须挂载的行 | 直接触碰视口或虚拟列表 |

### 接缝：`ConversationListHandle`

目前大纲、可见 turn 上报和原生选区都直接读取 `VirtualizerHandle`（`findItemIndex`、`getItemOffset`、
`scrollOffset`、`scrollToIndex`、`keepMounted`）。两种实现满足同一个接口，`view.tsx` 只按开关选择实现：

- 命令：`scrollToBottom()`、`jumpTo(anchor)`、`anchorMessage(messageId)`；
- 快照读取：当前 offset、某行的位置、某个 offset 处的行；
- 必须挂载的行：**同步输入**，而不是异步命令。`use-conversation-text-selection.ts` 要求这些行在
  Virtua 冒泡阶段的 scroll 监听之前提交，两种实现都必须保持这一时序；
- 可见 turn 上报回调。

接缝最先落地（P1），使用 Virtua 实现，不改变行为。

### 范围所有权与布局契约

行绝对定位在一个容器内，容器高度由适配器命令式设置；这个高度就是滚动范围，和现在的回复空间 spacer 一样。
布局契约如下：

- 容器在块方向为 `overflow: clip`，超出它的行不会增加可滚动溢出。
- **视口本身**声明 `overflow-anchor: none`，从而关闭整个滚动容器的浏览器锚定。只在行容器上设置（Virtua 现状）
  会让回复空间 spacer 和 overlay 仍然可以成为锚点。
- 视口保留 `scrollbar-gutter: stable`（`.chat-scrollbar`），滚动条出现不会改变行宽。
- 对话行内禁止 `content-visibility: auto`。对话里目前没有任何这样的声明；由于早先的 Streamdown 版本曾在代码块上
  内联设置它，这一契约用测试守住。
- 契约测试：视口的计算样式 `overflow-anchor` 为 `none`；渲染出的代码块计算样式 `content-visibility` 不是 `auto`。

除适配器外，唯一改变最大 offset 的是视口高度（composer、键盘、dock），视口观察者能看到它。

每次范围变化在适配器步骤内使用同一顺序：

1. 把范围扩到 `max(old, new)`；
2. 写入目标（总是 `<= newMax`）；
3. 把范围缩到 `new`；
4. 读回并取快照。

因此浏览器不会因我们自己的提交而 clamp 位置，范围增长也不会 clamp 需要它的那次写入。回复空间遵循同一顺序；
残留的旧范围从不被计为回复空间。

**布局独立性（终止性的前提）。**对固定的内容 revision 和外部布局版本，行高不依赖滚动范围、行自身的 `top`
或其他哪些行已挂载。行保持 `contain: layout style`，不使用相对容器的百分比高度。开发环境中，若一行的测量高度
在一个事务内发生变化，而内容和布局版本都没有变，就报告前提被违反。

**最小行高与豁免集 K。**除 `K` 中的行外，每一行满足 `height >= hMin`。`K` 按 key 静态定义，只包含固定的
非 turn 行（`FIXED_ROW_KINDS`）：leading 行、agent-activity 行，以及显示待提交消息的 trailing 行（`view.tsx`）。
leading 行可能是一个不渲染任何 DOM 的空 Fragment，这是 `ai-gui` 规则允许的；没有待提交消息时 trailing 行为空，
大多数时候都是如此。placeholder 行已带 `minHeight` 估算。开发环境中，`K` 之外任何测得低于 `hMin` 的行都会被报告；
切默认前做一次审计，确认目前 `K` 之外哪些行可能以接近零的高度渲染。

### 阅读锚点

React 行 key 与阅读锚点分离。`assistant-items` 的 `replace` 模式会替换一个 turn 的整个 item 数组，
`remove-turn` 删除 turn，`upsert-turn` 覆盖 turn（`packages/shared/src/session-data/history-actions.ts`），
所以单独的 item 下标不是身份。

```ts
type ReadingAnchor =
  | {
      kind: 'turn';
      turnId: TurnId;
      item: { index: number; identity: string | null; itemsRevision: number } | null; // null = turn 起点
      offsetPx: number;          // 锚点行内的像素偏移
    }
  | { kind: 'fixed-row'; key: 'leading' | 'agent-activity'; offsetPx: number };
type Intent =
  | { kind: 'follow' }
  | { kind: 'read'; anchor: ReadingAnchor; screenY: number }
  | { kind: 'sent'; turnId: TurnId };
```

`identity` 是 item 自带的稳定 id（如 tool call id）；`itemsRevision` 在 turn 的 item 数组被替换时改变。
解析规则：

1. **`itemsRevision` 相同且该 item 渲染为独立行：**使用该行，`offsetPx` 截断到行高以内。
2. **revision 已变：**按 `identity` 查找该 item；找不到则使用 turn 起点，`offsetPx = 0`。
3. **item 被折叠进组：**使用组头，`offsetPx = 0`。长行内 900px 的偏移无法对应 32px 的组头。
4. **turn 被删除：**对话索引无需水合就列出所有 turn，所以删除是可知的。按原顺序取下一个仍存在的 turn，
   其次取前一个，`offsetPx = 0`。
5. **turn 存在但尚未水合：**锚点保持待定并落在该 turn 的 placeholder 上；placeholder 从不替换锚点。
   读者停在 placeholder 内部时，锚点就是该 placeholder 行，偏移为读者的偏移（截断到其高度）。
   以同一 key 水合的 turn（user turn）保留这个偏移；水合成新 key 多行的 turn 落在其首行。
6. **`fixed-row`：**停在顶部的读者锚定到 leading 行。agent-activity 行消失时锚点回退到最后一个 turn；
   该行只出现在末尾，读者在那里通常处于跟随状态。

`offsetPx` 是像素位置；行在该点之上重排后，它不保证仍指向同一句话。

### 坐标

```text
rowTop(row)      = contentTop + prefixHeight(row)           // contentTop = 顶部 padding + inset
desiredScrollTop = rowTop(anchorRow) + offsetPx - screenY   // 截断到 [0, maxScrollTop]
maxScrollTop     = max(0, extent + bottomPadding + replyRoom + contentTop - viewportHeight)
```

大纲跳转使用 `screenY = 0`；发送的消息使用 `screenY = topPadding`，即第一行静止时的位置。
测量尺寸按布局版本（宽度、字号、字体加载、对话字号设置）键控；版本变化后旧尺寸只作为估算。
版本变化从不丢弃阅读锚点。

### 位移分类

适配器保存 `lastObserved = { scrollTop, maxScrollTop, geometryRevision }`，即它最后接受的位置，
无论这个位置是它写入的还是采纳的。每个 cycle 先采样 DOM，与 `lastObserved` 的差异分为：

| 类别 | 判定 |
| --- | --- |
| `own-write` | 等于当前 revision 下适配器待确认的写入 |
| `reader` | 有输入证据（滚轮、触摸、导航键、拖动滚动条）且 offset 发生了移动 |
| `clamp` | 最大值变小（视口增长或溢出变化）且 offset 等于 `clamp(lastObserved.scrollTop, 0, newMax)` |
| `unknown` | 其他一切：焦点、选区自动滚动、页内查找，或中间步骤未被观测到的 clamp |

各模式的处理：

- **`follow`：**只有读者输入释放该模式（I8）；`clamp` 或 `unknown` 移动都重新解析回底部。
  接受的代价：跟随时浏览器发起的离开底部的移动会被覆盖，因为跟随意味着读者要求看末尾。
- **`read`：**`reader` 或 `unknown` 移动被采纳为新锚点；`clamp` 保持意图并重新解析，
  位置重新可达时即被恢复。滚动条拖动时，滑块会覆盖相对补偿，锚点漂移，与现状相同。
- **`sent`：**与 `follow` 相同，只是读者输入会把模式释放为 `read`。

这是信息边界，而不是规则的漏洞：仅凭最终 offset，任何规则都无法同时做到"从不覆盖浏览器发起的移动"
和"从不误判未观测到的 clamp"。范围所有权使视口增长成为唯一的 clamp 来源，而视口观察者能看到它；
剩余的 `unknown` 情况在 `read` 模式下优先保留读者看到的内容，在 `follow` 模式下优先读者的明确选择。

命令（`scrollToEnd`、`jumpTo`、`anchorSent`）立即取得所有权。

### 写入形式

有两种写入形式，按写入原因选择，而不是按是否已观测到滚动：

- **`read` 模式下的布局补偿**是相对写入：`scrollBy(delta)`。`delta` 只是本 cycle 几何变化引起的锚点位移，
  每个几何 revision 只施加一次，从不包含读者的移动。
- **导航**是绝对写入：follow、`scrollToEnd`、`jumpTo`、发送、glide 帧和初始恢复。

如果读者在 cycle 采样与相对写入之间进行原生滚动，读者的移动会被保留；读回步骤（提交协议第 7 步）
检测到它，并在同一事务内覆盖新位置。事务之间，快于 overscan 的 fling 可能有一帧未渲染区域，
与任何虚拟列表相同；它不会持续：这次移动会排队一个 scroll 事件，而该事件与 `lastObserved` 不同，
其 cycle 会采纳并覆盖新位置。浏览器合成器线程与相对写入的交互，是每个支持平台上的验证项，而不是假设。

**v1 不延期：接受的 iOS 行为回退。**现状 fork 在 iOS 滚动进行中会延期 jump（`store.ts`：`isIOSWebKit()` 时
`applyJump` 把 jump 计入 `pendingJump`，`getItemOffset` 再减去它），这本质上是原点偏移：fling 得以保持，但理论上存在
第 2 轮评审给出的负方向空洞。v1 对每次补偿都执行写入。在 WebKit 上，程序化写入会结束 fling，我们按
"所有已发布的 iOS 版本都如此"处理。所以这是相对现状的行为回退，换来的是没有空洞，而且只影响私有移动端 app。
无条件延期已被否决：它的最终位置不是锚点推导的，评审给出的反例会让视口没有任何已挂载行。

**已设计的扩展，于 P4 决定：只延期正方向偏移。**fling 期间锚点上方内容增长时，用原点偏移 `D > 0` 布局，
前部行位于负的物理坐标：屏幕上不出现空洞，引理在偏移后的坐标系中仍然成立；在 `scrollend` 时以 `scrollTop + D`
吸收，这个位置总是可达。锚点上方内容收缩时立即写入。前提：

- 需要 `scrollend`（Safari 26.2 首次支持），不使用定时器回退；
- 读者在 `D > 0` 时滚到顶部，需要一次边界写入；
- I2 快照带上 `D`。由于所有消费方已经通过快照换算坐标，这是增量改动。

P4 用真机数据决定：惯性打断计数（见诊断）加上专门的"向上 fling 穿过未水合历史"测试。
向上 fling 时水合 placeholder 是最常见的补偿触发场景。

### 提交协议与覆盖引理

引擎产生的每个位置都由锚点推导：`S = clamp(rowTop(anchor) + offsetPx - screenY, 0, maxScrollTop)`。
这在所有模式下成立：

| 模式 | 锚点 | `screenY` |
| --- | --- | --- |
| `read` | 阅读锚点 | 记录值 |
| `follow` | 最后一个内容行 | 其底部位于 `V - bottomPadding`；进入 follow 时清空回复空间，与现在的 `enterFollow` 相同 |
| `sent` | 发送的行 | 顶部 padding |
| glide 帧 | 发送的行 | 从发送时的屏幕位置缓动到顶部 padding |

glide 插值的是 `screenY` 而不是像素。每帧按当前几何解析 `S(t) = clamp(p_current - screenY(t), 0,
maxScrollTop_current)`。起始 `screenY` 在预跳转之后记录；预跳转让该行进入一个视口以内（现状为 1.5 个视口，此处收紧），
因此 `screenY ∈ [-V, 2V]`；视口高度变化后针对新的 `V` 重新保证该界限。回复填满空间时，
follow 的目标在同一个 cycle 内取代 sent 的目标。

每个 cycle 在同一个同步事务内、以固定的内容 revision 和布局版本执行：

1. 采样 DOM 并对位移分类。
2. 根据意图和当前几何规划范围：未测量行使用估算，并加入选区必须挂载的行。
3. 提交（commit 0）。revision 相符的观察者条目已在几何中（I4）；读取仍为脏的行和新挂载行的当前尺寸。
4. 若有尺寸与已提交几何不同，commit 1 提交新几何；若新几何下的*目标*视口未被覆盖，同一次提交还挂载
   最坏情况窗口。读取新行。
5. 若尺寸再次变化，commit 2 提交该几何。事务内窗口从不缩小。
6. 在已提交几何上解析（`resolvedRevision === committedRevision`），得到 `S_expected`；按写入原因选择形式，
   并按上文的范围顺序写入；在范围操作之后读回 `S_actual`。
7. **核对读回。**若 `S_actual` 与 `S_expected` 不同，且无法由已知 clamp 解释，这个差异就是随相对写入一起到达的
   外部移动。在同一事务内把它分类为 `reader` 或 `unknown`，从 `S_actual` 采纳阅读锚点（`screenY = 0`），
   并围绕它再执行一遍第 2–6 步。采纳使新位置成为锚点推导的，所以引理同样适用于这一遍。
8. 取快照。`lastObserved` 只设为本事务已验证覆盖的位置。若重跑的一遍中再次出现不一致，`lastObserved`
   保持最后一个已覆盖的位置，事务以记录 `pendingExternalMove` 结束。offset 在本 task 内已经改变，
   所以 scroll 事件已经排队（CSSOM pending scroll targets）；它与 `lastObserved` 不同，不会被当作
   no-op 吸收，其 cycle 会采纳并覆盖该位置。之后报告相同 offset 的事件不会清除 `pendingExternalMove`，
   只有覆盖了该位置的 cycle 才会清除。

在我们支持的浏览器里，主线程的滚动 offset 不会在一个 task 内改变，所以预计很少需要重跑，
第二次不一致也不会发生；但协议并不依赖这一点。

**最坏情况窗口**是锚点行加上两侧各 `ceil((1 + a) · V / hMin) + |K|` 行，或延伸到列表两端。`a` 界定
`screenY` 可以超出 `[0, V]` 多远：glide 帧 `a = 1`，其余均为 `a = 0`。`K` 中的行可能为零高度，
所以每侧多加 `|K|` 行（`|K| = 3`，`worstCaseWindow` 从 `FIXED_ROW_KINDS` 读取）。trailing 行是合入 #719 的待提交消息时
加入 `K` 的；论证对任意 `|K|` 都成立。

**引理。**假设事务的内容与布局版本固定，且布局与位置无关（布局契约）。最后一次提交后，窗口内每一行都已测量、
已提交，且 `K` 之外的每一行高度至少为 `hMin`。写入位置由锚点推导，所以对锚点位置 `p` 有
`S ∈ [p - (1 + a)V, p + aV]`，clamp 只会把 `S` 推向列表某一端。窗口在锚点两侧各至少包含 `(1 + a)V` 的内容
（其中至多 `|K|` 行可能为零高度，已额外计入），或到达列表端点，因此 `[S, S + V]` 的内容部分被覆盖。
测量窗口内的行会改变 `p`，但不会改变窗口包含哪些行，所以无需第三次提交。回复空间与 padding 位于
`contentEnd` 之外，不需要行。评审方枚举了不含 `K` 的静态模型（812,025 种组合；glide 界限取 `a = 1.5` 时为
1,353,375 种），没有发现反例；这支持了算术部分，但不是浏览器协议的证明。

**终止性。**一个事务最多两遍，每遍最多两次补充提交。在布局契约下，事务自身的重定位和范围写入不改变任何行尺寸；
观察者只在当前读取值与已提交尺寸不同时才标脏，所以我们自身提交引起的观察者投递都是 no-op。
新事务只由新内容、布局版本变化、输入、视口变化或命令启动，而每一种都只引起有限个事务。
这个论证不依赖 ResizeObserver 的投递频率；开发断言会捕捉违反布局契约的情况，因为那会重新打开循环。

补充提交通过 layout effect 内调度的状态更新完成（React 在绘制前应用），在观察者回调中则用 `flushSync`。

**性能形态。**由 ResizeObserver 驱动的事务（流式输出的稳态）直接采纳条目尺寸，不强制布局；只有补充提交新挂载的行
需要同步读取，并且一次批量读完。由 scroll 驱动的 cycle，若已提交几何已覆盖目标视口，就只读 `scrollTop`。
最坏情况窗口一帧内最多挂载 `2((1 + a)V / hMin + |K|)` 行：`V = 1000`、`hMin = 40` 时约 54 行，glide 时约 104 行；
预计只在估算严重偏差的首次打开时出现。现有 hook 也不便宜：每次几何回调都会读 `scrollHeight`，范围与 blocker
检查会读取所有已挂载行的矩形。因此基线必须实测，而不是假设。

不存在降级的、未覆盖的结果：数据尚未就绪的 turn 渲染其 placeholder，它和其他行一样是一行。

### 打开与恢复

每个会话保存 `{ formatVersion, intent, 按 key 与布局版本的尺寸 }`。`sent` 意图保存时归一为 `follow`
（现状 anchored 模式已经保存 `{ type: 'end' }`）。这些缓存和现在一样（`use-scroll-position-cache.ts`），
是模块级的内存 LRU，不会跨应用重启持久化，所以格式变化不是一次性的迁移。两种实现各用自己的缓存键；
运行时切换开关后，另一侧的缓存可能过期或为空，受影响的会话会打开在末尾一次。水合窗口在第一次视口上报之前
按恢复锚点的 turn 选择；尾部租约和 `factSource ?? view` 来源隔离保持不变。

`initialScrollRestored` 被移除。Electron 的 warm-window reveal 等待 `data-window-session-stream-ready`；
该属性只有在 `initialWindowReady` 成立**且**首个 cycle 已完成时，才在完成首个 cycle 的那次提交中设置。
因此窗口不会在 placeholder 上揭示，而属性出现时，已覆盖的行已经在 DOM 中。

### 发送、跳转、选区、诊断

- **发送：**`anchorSent` 预留回复空间并 glide，每帧重新解析目标；回复填满空间时交接给 follow。
- **大纲与搜索：**`jumpTo(anchor)` 设置 `read` 意图，从而去掉修正循环和 150ms 的请求寿命。
- **选区：**完整保留选区协议（区间、内容快照、历史租约）；其必须挂载的行通过 handle 同步进入范围规划。
- **诊断：**一个常开的环形缓冲，每个 cycle 记录：
  - 来源代次、几何 revision；
  - 意图类型与位移类别；
  - 目标 offset、实际 offset 与 clamp；
  - 使用的补充提交次数；
  - 由已提交矩形测得的视口覆盖情况；
  - 触摸惯性期间的补偿写入次数，以及其中结束 fling 的次数（写入后下一次采样不再有移动）。

  其中不含文本，并随 bug report 提交。I2 和 I3 的违反在开发与测试中直接抛错。

## 移除与保留

**从对话中移除：**

- 揭示门及其 blocker；
- 缓存偏移重放和合成 scroll 派发；
- Virtua 的 store、observer 和 driver；
- 大纲修正循环和 `itemOffsetDelta`；
- 像素位置缓存。

P6 同时移除 fork 的 keyed React/store 部分（`keyed` prop、`ACTION_ITEMS_KEYS_CHANGE`、`useChildren` 的 key 传递）；
keyed 布局本身已在 P2 迁入引擎。

**保留：**

- follow/read/sent 语义与输入证据；
- glide 与回复空间；
- 水合窗口策略与来源隔离；
- placeholder 与选区协议；
- 按 key 的尺寸记录（改为引擎自有）；
- 每会话缓存（改为带版本）。

## 备选方案

- **修补现有这一对：**同 offset 的 scroll 时解除冻结、重放后重新检查、总是通知 Virtua。这只修复 A 和 B；
  负责人于 2026-09-27 拒绝了短期补丁。
- **改 fork 的核心，或从 fork 导出 keyed 布局给引擎使用：**否决。引擎需要按布局版本键控的尺寸，
  这放在引擎自有代码里，比在一个希望 `VList` 消费方贴近 upstream 的 fork 里增加更多 `Lody:` 标记更合适。
- **从零重写几何：**keyed 布局是纯函数且已有测试，引擎把它连同测试一起迁入。
- **惯性期间双向平移布局原点：**已撤回。负方向偏移会打开可以进入的空白空洞，并可能要求不可达的 offset
  （第 2 轮评审）。
- **惯性期间延期所有补偿：**已撤回。延期后的位置不是锚点推导的，反例会让视口没有任何已挂载行（第 3 轮评审）。
- **只延期正方向偏移：**未否决；已在上文设计，于 P4 决定。
- **TanStack Virtual：**同样按增量补偿，也不锚定列表中间的插入（#945）。
- **普通文档流虚拟化加原生 `overflow-anchor`：**这里无法确认 WebKit 的支持情况，锚定启发式也不在我们控制之内。
- **保留揭示门并加活性定时器：**违反无定时器规则，而且只限制症状。

## 验证计划

1. **先用真实代码复现。**写 jsdom 测试，使用真实 hook 和真实 Virtua，分别经由路径 A、以及生产 overscan 下的
   路径 B 最终停在隐藏状态；再加一条"读回包含并发移动、随后收到同 offset 事件"的轨迹。它们是引擎的验收测试，
   在开关切换前标记为预期失败。
2. **在引擎核心上做模型测试，模拟器按规范字面实现：**
   - 写入时 clamp 到写入那一刻的当前范围；
   - `scrollBy` 加在当前值上；
   - 每次渲染更新中每个目标最多排队一个 scroll 事件；
   - 在 scroll 处理函数里的写入，为下一帧排队事件；
   - HTML "update the rendering" 中 scroll 步骤先于 ResizeObserver；
   - 观察者只在尺寸变化时投递。

   真实状态变化发生时，通知从不丢失。轨迹：
   - 旧范围仍已提交时的写入；
   - 同一 task 内的 `A → B → A`；
   - 同值写入；
   - 合并后的通知；
   - 早于尺寸变化上报的 clamp；
   - 最大值在采样前又恢复的 clamp；
   - 旧位置仍合法时，焦点恰好落在新的最大值上；
   - 已生效但尚未派发的原生滚动；
   - 无位移输入之后的流式输出和 `scrollToEnd`；
   - 读回中包含并发读者移动的相对写入；
   - **上方内容增长时的滚动条拖动**；
   - 改变几何但覆盖仍成立的测量；
   - 同一节点的连续内容更新；
   - item 替换、turn 删除、长行折叠为短组头；
   - 零高度的 `K` 行；
   - 极小和超大的行、端点 clamp 以及来源切换。

   每一步都检查 I2–I6 和 I8、引理的提交次数上界，以及不存在自激 cycle。
3. **适配器测试**（jsdom）：提交协议、范围所有权、标脏、观察者条目采纳、来源隔离，以及同步必须挂载的时序。
4. **契约测试：**视口计算样式 `overflow-anchor` 为 `none`；渲染出的代码块 `content-visibility` 不是 `auto`；
   `K` 之外的行测得至少 `hMin`。
5. **观察过程的浏览器测试**，对两种实现参数化运行。记录首个绘制帧、已提交行矩形与视口的关系、锚点屏幕位置和
   每一次程序化写入。覆盖：
   - 路径 A–C；
   - 之后再无任何事件投递的最后一个 cycle；
   - 未派发的原生滚动；
   - 消失的锚点；
   - 跨行选区；
   - 宽度与字体变化。
6. **验收**：桌面应用，以及 iOS 真机（见验收清单）。

## 迁移

每个阶段都可以独立合并、独立回滚。

| 阶段 | 内容 | 产品行为 |
| --- | --- | --- |
| P0 | 限时线上确认：设置 `localStorage['lody:debug-scroll']='1'`，出现空白时执行 `__lodyScrollLog.dump()`。最后一条 `reveal-blocked` 能区分 A（`cached-offset-reapplied`）、B（`target-unmounted`）和已排除的水合路径（`initialWindowReady: false`）。写 jsdom 复现（验证计划第 1 条），标为预期失败。两者都不阻塞后续阶段。 | 不变 |
| P0.5 | components e2e 接入 PR CI：Storybook 构建加 Playwright，放在**独立的 runner job** 中（runner 为 4 vCPU，CPU 是瓶颈）。路径过滤覆盖引擎、`hooks/`、`components/ai-gui/`、水合与行构建、Markdown 与排版样式、`packages/virtua`，以及这些 spec 和 stories 本身。先只跑与滚动相关的 spec。它排在 P1 之前，让接缝重构有浏览器验证。 | 不变 |
| P1 之前（建议，由负责人决定） | 两个带测试的契约小修：视口级 `overflow-anchor: none`，以及 `content-visibility` 契约测试。它们是独立缺陷，不是被拒绝的空白问题补丁。 | 前者改变浏览器锚定 |
| P1 | `ConversationListHandle` 接缝，使用 Virtua 实现；`view.tsx`、选区和大纲都经由 handle。 | 不变 |
| P2 | 纯引擎核心和按规范字面实现的模拟器。fork 的 keyed 布局迁入引擎，连同 `list.spec.ts` 与 `tests/keyed-list.test.ts` 原样迁入，先在引擎目录里全绿，再做布局版本扩展。P2 至 P5 期间 fork 里的 keyed 布局**冻结**。 | 不变 |
| P3 | DOM 适配器和列表实现同一个 handle，放在一个设置 atom 之后，沿用 `developerModeEnabledAtom` 下显示 beta 开关的现有模式，默认关闭；e2e 对两种实现都运行。 | 默认不变 |
| P4 | 内部 dogfood，打开开关至少一周，收集环形缓冲；用 iOS 真机数据决定是否做正方向延期。 | 仅内部 |
| P5 | 通过该 atom 的构建时默认值常量切换默认；旧路径至少保留一个完整发布周期。回滚方式是改常量后发版，或用户在设置中关闭。 | 改变 |
| P6 | 删除旧路径；更新 hooks 与 `ai-gui` 的 `AGENTS.md` 规则、warm-window 契约和[对话滚动](../../../../specs/conversation-scroll.md) Spec（改为 `draft`）；移除 fork 的 keyed React/store 部分，收缩其 README "Changes from upstream"，并逐一核对剩余的 `Lody:` 标记。 | 清理 |

在 P5 之前，当前的故障仍然存在。

### 切默认（P5）验收清单

1. **自动化测试，PR CI 全绿：**
   - P0 的复现测试在引擎上通过、在旧路径上失败；
   - 模拟器套件在固定 seed 集合上全绿；
   - 适配器测试；
   - 契约测试；
   - components e2e（水合、选区、大纲、发送及过程观测用例）对两种实现都通过；
   - `use-sticky-scroll.test.ts` 的行为用例迁移到 handle 层后，对引擎通过。
2. **手测，平台 × 场景：**
   - 平台：
     - macOS 桌面：触控板惯性、鼠标滚轮、滚动条拖动；
     - Windows：鼠标滚轮；
     - Web：Chrome 与 Safari；
     - iOS：最低支持版本和最新版本各一台真机。
   - 场景：
     - 在末尾和历史中段重新打开；
     - 冷启动；
     - 流式输出中打开；
     - 发送 glide；
     - 大纲与搜索跳转；
     - 跨行选区与复制；
     - composer 伸缩与键盘；
     - 宽度与字体变化；
     - warm-window 揭示；
     - **iOS 上向上 fling 穿过未水合历史**。
3. **性能，与旧路径同机同数据比较：**2,000-turn 合成对话（window-bootstrap benchmark）加一个真实长对话。
   - 打开到首帧 p50/p95 劣化不超过 10%；
   - 流式输出帧耗时 p95 不劣于基线；
   - 稳态流式帧的强制布局次数不超过基线；
   - 记录最坏窗口触发次数，且它不出现在稳态流式路径上。
4. **dogfood 诊断：**
   - I2/I3 违反为 0；
   - `pendingExternalMove` 残留为 0；
   - 惯性打断计数已为 P4 决策评审；
   - 内部没有新的空白面板报告。

## 待定决策

- **iOS fling 打断（仅私有移动端 app）：**维持 v1 接受的回退，还是交付正方向延期；于 P4 依据打断计数和真机测试决定。
  对这一扩展而言，唯一相关的版本线是 `scrollend`（Safari 26.2）。
- **P1 之前的契约小修：**是否先单独上线（建议）。
- **零高度审计：**`K` 之外的行，在 P5 之前完成。
- **行重排后 `offsetPx` 取像素还是语义位置：**本提案采用像素。

## 实现状态（2026-09-27）

**上线决定。**P0 至 P3 先以 Developer-mode 开关之后的形式实现；随后负责人决定直接上线。开关、Virtua scroller、
`use-sticky-scroll.ts`、`sticky-scroll-dom.ts`、`use-scroll-position-cache.ts` 及其测试均已删除，因此没有应用内回退：
回退就意味着发版。原属 P4 的证据（iOS fling 打断、零高度审计、性能剖析）改为上线后通过下文的诊断收集。

**已实现（P0 至 P3、两个契约小修，以及旧路径的移除）：**
- **P0。**用真实 hook 和真实 keyed Virtua 做的 A+B jsdom 复现，配合帧 harness
  `tests/support/scroll-frame-harness.ts`（按浏览器顺序投递 scroll 事件和 ResizeObserver）。小幅展开会自愈；
  十四行的展开会一直隐藏，屏幕上没有任何行被挂载，直到"回到最新"。
- **P0.5。**CI 任务 *Conversation browser tests*：每当 components 测试组运行时，在单 worker 上运行水合 spec 和引擎 spec。
  暂不属于必需的 *Tests* 检查。原生选区 spec 未纳入：其中的"finishing a selected turn keeps its prose mounted"在未改动的
  `main` 上同样失败（3 次中 3 次）；一个流式 spec 在负载下对时序敏感。
- **契约小修。**视口声明 `overflow-anchor: none`；契约测试 `tests/conversation-viewport-contract.test.tsx` 对两种实现都断言这一点，
  并断言引擎从不隐藏视口、静态与流式代码块都不带 `content-visibility: auto`。
- **P1。**`ConversationListHandle` 与 `ConversationScrollerProps`（`components/ai-gui/conversation-list/`）。
  大纲、可见 turn 上报和原生选区都经由 handle；选区 hook 只需要 handle 的 `findItemIndex` 这一项列表读取。
  两种实现并存期间，一个 Virtua scroller 在同一 handle 之后原样承载旧代码，浏览器 spec 显示没有回退（见下文）；
  它已随旧路径一起删除。
- **P2。**引擎核心（`lib/conversation-scroll/controller.ts`、`geometry.ts`、`anchor.ts`、`saved-state.ts`、`types.ts`），
  以及连同测试迁入的 keyed 布局（先原样通过，再加入 `Engine:` 扩展：按行估算和 `$invalidate`）。
  模型测试使用模拟器 `tests/support/scroll-engine-sim.ts`：场景测试加 40 个固定 seed 的随机序列，检查覆盖、贴底、锚点稳定和提交上界。
- **P3。**`EngineConversationScroller`（React 适配器）、由 `ChatVirtualRow` 构建的行元数据，以及在 `SessionChatStream`
  中于第一次视口上报前加载恢复锚点所在 turn 的水合窗口。行组件类型（`ConversationRowComponentProps`）归
  `conversation-list/` 所有，对话不再导入 `@lody/virtua`。
- **fork 已删除。**对话移走后已没有地方传 `keyed`：按 key 保存尺寸由引擎复制的 `keyed-layout/` 负责，
  阅读锚点取代了 Virtua 侧的锚定。格式化后，fork 与上游 0.52.7 只差 keyed 改动，因此删除了 `packages/virtua`，
  两个 `VList` 使用方（分页文件查看器、项目设置）改为依赖上游 `virtua` 0.52.7。Virtua 的 MIT 许可证移到 `keyed-layout/LICENSE`。
- **移除旧路径时发现的问题。**范围起点若落在零高度行上，会漏掉同一条线上的其他零高度行（例如空的 leading Fragment）；
  现在范围起点会向前回溯越过它们。
- **大纲跳转落点偏过目标轮次（staging 测试中发现）。**`view.tsx` 里 Virtua 时代的修正循环还在运行：`scrollend` 时它按点击时
  记下的行号再跳一次；目标附近的 placeholder 展开后，这个行号已指向别的轮次，于是从第 400 轮跳到第 410 轮会落在第 420 轮。
  设计本来就去掉了这个循环（阅读锚点会让跳转的行保持在顶部），现在它连同附带的跟随抑制已被删除。一个 Chromium spec 依次
  点击远处、近处和开头的轮次，断言每次都落在 1px 以内，并且大纲高亮正确。
- **PR review 中发现（#1071，Claude 会话 `dfd4a856`）。**
  - **停在 placeholder 内的读者会被吸到该 turn 顶部。**读者移动时锚定顶线下的任意行，placeholder 也不例外；
    但解析器的同 key 快速路径跳过 placeholder，锚点于是走到规则 5，偏移为 0。下一次事务就写入 `scrollBy(-offsetPx)`，
    于是每一步停在未读历史上的滚轮都会向上跳，幅度最多为一个 placeholder 的高度。user 行的锚点在其 turn 被逐出后同样如此，
    因为 placeholder 与该 turn 共用 key。现在快速路径接受同 key 的 placeholder，并把偏移截断到它的高度。
    - 模型测试覆盖：停在 placeholder 内且无写入、同 key 与新 key 水合、逐出后再水合，以及穿过混合 turn 的滚轮行走
      （断言顶线下的行每一步恰好移动一个步长）。其中三个在旧快速路径下失败。
    - Chromium 滚轮测试原本只断言空白帧，看不到位置错误。现在它还检查每个稳定的步骤里，顶部行恰好移动滚轮的距离。
      它在旧快速路径下仍然通过，因为 story 的窗口在滚轮停下之前就已水合了这些行；这个 bug 的回归保护是模型测试。
  - **读者输入的行为覆盖随旧 hook 删除，没有迁移。**adapter 测试现在派发真实事件，并断言模式和位置：
    - 向上滚轮释放跟随；
    - 嵌套滚动容器、向下滚轮或缩放手势不释放；
    - 向上导航键释放跟随，可编辑字段中或列表外的控件上除外；
    - 没有指针或触摸的向上移动会回到末尾，按住滚动条或触摸拖动时的向上移动则释放；
    - suppression 在下一次变化时释放跟随。

    逐一去掉每个监听行为，对应测试都会失败。
  - **StrictMode。**卸载清理会永久 dispose controller，但 StrictMode 的开发期重挂载会在仍然存活的组件上先运行清理、
    再运行 setup。现在 setup 调用 `resume()`，并有一个 StrictMode 的 adapter 测试覆盖。
- **回复流式输出时，快速向下甩动停在末尾之前（发布后发现，2026-09-29）。**读者停在上方时流入的行从未挂载，
  下方的范围是估算值，通常偏短。快速向下甩动途中会挂载并测量这些行，引擎随之增大范围；但合成器按它收到的
  最后一帧的范围夹住甩动。主线程落后时（流式输出期间正是如此），甩动就停在这个过时的底部。下一个滚动事件
  看到的底部已经移动，4px 的重新启用规则永远匹配不上：读者停留在阅读模式，离末尾最多差一屏，而输出继续在
  下方增长。现在引擎记录一段滚动序列期间范围曾有过的每个底部；向下的序列停在其中之一时，重新启用 follow
  并移到真正的末尾。
  - 一个模型测试复现了过时底部，旧规则下失败；另一个测试确认停在其他任何位置的向下滚动保持阅读模式。
    种子序列增加了“向下滚动并停下”一步。这一步暴露了一个过严的 I5 检查：被夹住的阅读位置会在变得可达时
    移向其锚点（见上文 `read` 的处理），所以 I5 现在只适用于变化前已经解析的位置。
  - 在真实桌面应用中，用合成器甩动手势在回复流式输出时驱动：旧构建 16 次快速甩动中有 3 次停在过时底部并
    保持阅读模式；修复后的构建 32 次全部停在末尾并处于跟随状态。这一竞态取决于主线程落后多少（旧构建有一轮
    8 次一次也没触发），所以确定性的回归保护是模型测试。
- **依赖旧路径的测试。**
  - 水合 e2e 的 cold-tail 测试原本断言行测量前视口保持隐藏，现在改为断言在任何行观察到达之前，尾部或保存的阅读行
    已经就位。
  - activity 测试原本把 `Virtualizer` mock 掉，现在像指针那样先装配行，再打开其中的浮层。

**与上文设计的差异：**
- **未跟踪 item revision。**历史数据没有 items revision，所以锚点记录行 key（优先尝试）、item 下标以及作为身份的 tool call id。
  当 turn 的 item 被替换时，同一下标处的文本 item 会被视为同一个。
- **行测量。**观察者投递把尺寸不同的行标脏；随后 cycle 在观察者回调内（此时布局是干净的）读取当前尺寸。
  由提交挂载的行在该提交的 layout effect 中读取。
- **布局版本**是宽度加对话字号设置；字体加载没有单独跟踪。
- **最小行高**`hMin` 为 `ENGINE_MIN_ROW_PX = 20`；固定行之外测得更低的行只在开发环境中报告。
- **诊断。**
  - 每个 cycle 都进入常开的环形缓冲 `window.__lodyScrollEngineLog.dump()`。
  - 未覆盖的 cycle 和带有待处理外部移动的 cycle 还会追加到 session render trace，崩溃报告的复制内容包含它。
  - 每次触摸 fling 之后的 `scrollend`，惯性计数（补偿写入次数，以及其中结束 fling 的次数）也写入同一 trace。
  - 普通 bug report 目前还不包含它们。

**证据（已执行）：**
- components 套件：接缝重构后 530 个文件全部通过。新增套件：
  - `conversation-scroll-engine.test.ts`：52 个测试；
  - `engine-conversation-scroller.test.tsx`：3 个；
  - `sticky-scroll-open-stall.test.tsx`：2 个；
  - `conversation-viewport-contract.test.tsx`：5 个；
  - keyed 布局套件：14 个；
  - `conversation-view-hooks.test.tsx` 中的一个 focus 测试。
- 真实 Chromium，`tests/e2e/conversation-scroll-engine.spec.ts`（3 个通过）：
  - 打开 3,000 turn 对话；
  - 30 次向上滚轮（只检查覆盖；位置检查是 review 之后加的，见上文）；
  - 在两个已加载的 3,000 turn 对话之间切换再切回。

  每个动画帧里，每条采样线下都有行；切回后顶部行相同，偏差在 2px 以内。
  反向对照：同一采样器在 Virtua 路径上记录到 22 个空白帧（该路径在打开时隐藏视口）。
- 现有 Virtua 路径的浏览器 spec（单 worker）：本分支 12 个通过、1 个失败；未改动的 `main` 上 11 个通过、2 个失败，
  两边失败的是同一个选区测试。

**剩余：**
- 上线后：读取惯性计数和诊断，决定是否做 iOS 正方向延期扩展，审计低于 `ENGINE_MIN_ROW_PX` 的行，并剖析长对话性能。
- Spec 已按 `draft` 修订（按行恢复；打开时绝不空白）。

## 隐藏的视口（2026-09-29）

**故障。** 0.101.0 在 `SessionChatStream` 边界里因 React #185 崩溃。崩溃报告的
render trace 显示，用户刚离开的子 tab 在切走后约 50ms 内出现了
`scroll-engine <tab> commit covered=false … ×51`。这个 tab 第一次被隐藏时也出现过
同样的一串。

**原因。** 非激活的子 tab 以 `display: none` 保持挂载（`session-detail.tsx`）。
没有布局框的视口，所有偏移和尺寸都读成 0，写入也会被丢弃。适配器仍在每次 commit
后运行一次事务。写入虽然被丢弃，但 `writePhase` 把期望偏移夹到了隐藏后的范围，
于是接受了 `0` 并上报 `onScroll(0)`。这个偏移会进入视图中由位置派生的状态：顶部
渐隐、大纲索引，以及会移动 hydration 窗口的可见轮次上报。这些更新发生在 layout
effect 里，列表因此同步 commit，又一次上报 0。大多数 tab 在约三次 commit 内到达
不动点，这个 tab 没有。scroll repro 笔记里记录的锚点 ↔ hydration 翻转很可能是驱动
因素，但用合成数据没有复现出来。

**决定。** 视口隐藏时暂停引擎。`SessionChatInterface.isVisible` 经
`SessionChatStream`、`SessionChatStreamView` 传到滚动器的 `hidden` prop，在 render
中调用 `controller.setHidden`。隐藏期间：

- `afterCommit` 记录已提交的计划，但不开启事务；
- 忽略 scroll 事件、行和视口的 resize、命令和 glide，进行中的 glide 会被取消；
- 保留意图（follow、read 锚点、sent），期间发出的命令在 tab 显示时生效；
- 不测量尺寸，零高度不会进入 geometry。

重新显示后的第一个事务（`reshow`）会刷新视口，不把 DOM 偏移当作读者的移动（浏览器
可能已经丢弃了它），并以绝对写入落到保留的意图。`lastObserved` 不重置，所以隐藏
期间 `scrollOffset` 保持最后一次真实值。以隐藏状态挂载的列表要等到首次显示才完成
首个周期。warm window 的显示不受影响，因为它只等待可见的目标 stream。

**备选方案。**

- _从 DOM 检测有没有布局框_（`getClientRects()`、`offsetParent`）。它能覆盖忘了传
  prop 的宿主。但 jsdom 把所有元素都报告为没有布局框，所有依赖首个周期完成的测试都会
  卡住。它也违背了仓库"隐藏时的工作由实际可见性驱动"的规则。
- _抑制消费方_：只上报变化了的偏移，或限制 hydration 反馈。这两种都只去掉一个驱动
  因素，引擎仍会给没有位置的视口编造位置。

**测试。** 模型：`tests/conversation-scroll-engine.test.ts` 的 `hidden viewport`。
模拟器模拟 `display: none`（读数为零、写入被丢弃、偏移丢失）。隐藏中的读者和跟随者
都不上报、不写入，再次显示时分别回到锚定的行，或回到隐藏期间流入内容的真实底部。
适配器：`tests/engine-conversation-scroller.test.tsx` 中一个在偏移为 0 时翻转状态的
视图，去掉暂停时复现 "Maximum update depth exceeded"，加上后通过。

## 证据

- 代码：
  - `packages/components/src/hooks/use-sticky-scroll.ts`、`sticky-scroll-dom.ts`、`use-scroll-position-cache.ts`、
    `use-conversation-text-selection.ts`；
  - `packages/components/src/components/ai-gui/view.tsx`、`assistant-turn-render-blocks.ts`；
  - `packages/virtua/src/core/store.ts`、`observer.ts`、`layouts/list.ts`、`src/react/Virtualizer.tsx`；
  - `packages/shared/src/session-data/history-actions.ts`；
  - `apps/electron/src/renderer/src/warm-window-reveal.ts`；
  - `packages/components/src/tailwind/index.css`（`.chat-scrollbar`）。
- 已执行的探针（固定行高，均非浏览器复现）：
  - 作者会话（`5d8fa2ca`）的 store 层探针：keyed 行高 100px、视口 300px、offset 500、无 overscan。同 offset 的 scroll 之后范围停在
    `[8, 10]`，而视口实际显示 `[5, 7]`；
  - Codex 使用真实 blocker 函数的探针：
    - 一行变四行、无 overscan：`null`，与视口相交的行数为零（路径 C）；
    - 一行变四行、800px overscan：`null`，有三行相交；
    - 一行变十四行、800px overscan：`target-unmounted`。
  - Codex 在内存中构造、促成第 2–4 轮修改的反例：原点偏移空洞、测量集合增长但仍未覆盖、几何提交前的写入、
    未覆盖的延期分支、写入之后才扩范围、依赖布局的行高、吸收了并发移动的读回；
  - Codex 对静态引理的枚举：见"覆盖引理"一节，均无反例。
- Claude 会话 `dfd4a856` 的外部核实：
  - `@lobehub/streamdown@1.4.0`（`packages/components/package.json` 中钉住的版本）：在包 tarball 的 `dist/` 中
    grep `content-visibility` 和 `contentVisibility`，零命中。因此 #1002 删除旧覆盖是正确的，现状没有回退；
  - `https://webkit.org/blog/18325/webkit-features-for-safari-27-0/` 中没有任何关于"程序化滚动中断惯性"的修复；
    早先对这类修复的引用已删除；
  - caniuse 的 `scrollend` 事件条目：桌面与 iOS 的 Safari 均从 26.2 起首次支持。
- 实现后执行的验证：见"实现状态"。
- 评审（2026-09-27）：Codex（GPT-6 Astra）会话 `0bc8379d-78b4-4a13-bee7-4ec862c9bf52`，五轮；
  Claude 会话 `dfd4a856`，三轮。
