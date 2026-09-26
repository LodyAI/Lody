# 对话跟随模式

Status: implemented
Translation: current

[English](2026-09-23-conversation-follow-modes.md)

## 摘要

对话吸底经常失效，在 Composer 里输入时对话会跳一行。两者都源于从滚动方向推断读者意图：
`use-stick-to-bottom` 把浏览器夹紧（Composer 变矮导致视口变高）当成读者上滚而解除跟随；
而一次性的 Composer 跳过标志让跟随中的对话被变高的 Composer 盖住底部。现在由
`use-sticky-scroll.ts` 持有显式的 `follow` / `anchored` / `free` 模式，只有读者输入能解除；
直接发送会把消息钉在视口顶部，并为回复预留下方空间。单元测试覆盖了每个状态转换；真实应用中
的验收和"打开时反复闪烁"的成因仍待确认，为此新增了滚动时间线日志。

## 问题与发现

- Composer 变高时设置 `skipNextViewportResizeAutoScrollRef`（#131），视口 ResizeObserver
  因此跳过贴底修正：`scrollTop` 不变，最后一行滑到 Composer 下面，下一个流式分片再把它拉回来，
  即看到的"弹跳"。
- Composer 变矮（删一行、发送后清空）使视口变高。浏览器先把 `scrollTop` 向上夹紧并在任何
  ResizeObserver 之前派发 `scroll`。库的方向判断（`scrollTop < lastScrollTop`）据此解除跟随；
  被跳过的修正也无法把这次写入标记为程序滚动。这很可能是"吸底经常失效"的主要来源。
- 跳过标志不保证被消费，可能吞掉之后真实的 resize（窗口、终端面板）。
- hook 自己的 wheel 监听对任何向上滚轮都解除跟随，包括滚动内部代码块或终端的情况。库自带的
  wheel 判断因视口计算出的 `overflow` 是 `"hidden auto"` 而从未命中视口。

## 决策

模式保存在 hook 中；观察器永远不改变它。

- 解除：未被内部滚动元素消费的向上滚轮、非可编辑目标上的向上导航键、按住指针或触摸时的向上滚动
  （拖滚动条、选区自动滚动、触摸拖动）。无按住时的向上滚动是夹紧或尺寸修正，忽略。
- 重新跟随：向下滚动且停在距真实底部 4px 内、且预留空间已为零；显式跳到底部；发送。
- 自己写入的 `scrollTop` 会被记录，其 scroll 事件不视为意图。
- 缓存的阅读位置同步恢复，并在每次几何或滚动回调时重新应用，直到显示；任何导航（解除跟随、
  被抑制的跳转、显式回到底部、发送）都会放弃它。这把 PR #896 的
  [初始滚动恢复](../bug-fix/2026-09-23-initial-scroll-recovery.zh.md) 带入了跟随模式。
- 视口高度变化保持当前模式的位置；删除跳过标志。
- 直接发送（Agent 空闲）锚定该用户行：该行滚到首行静止时的位置，`Virtualizer` 之后的元素预留
  `target + viewport - bottomPadding - contentEnd` 像素。回复增长时它等量收缩，画面不动；
  归零后切换为 `follow`。比视口还高的消息改为从底部跟随。非 `anchored` 时预留空间只缩不增，
  缩到刚好保持当前位置可达，因此上滚会吃掉它而不跳动，且不会再出现。排队和 guide 发送不动视口。
- 移到锚点是 360ms ease-out 的滑动，由 `requestAnimationFrame` 驱动，而不是瞬间跳过去。它每帧
  重新读取目标位置（落点的行仍在测量；回复可能在滑动中填满预留空间，此时继续滑到底部），在第一帧
  之前先预留空间，读者一有输入解除模式就停止。一次滑动最多 1.5 个视口；更远时先跳到这个范围内，
  避免滑过未挂载的行。否决了原生 `scrollTo({ behavior: 'smooth' })`：任何修正写入都会打断它，
  且其中间 scroll 事件无法与读者输入区分。开启"减少动态效果"时直接跳转。
- 预留空间是虚拟化内容的兄弟元素而非 Virtua 行：作为行会移动索引、使按行数缓存的测量失效，
  并进入大纲计算。

保留库并修补其启发式被否决：hook 已经自己重做了内容观察并在对抗库的重新加锁；仅凭 scroll
事件无法区分夹紧与真实上滚。

## 打开时的闪烁

本次未修复。怀疑：显示后阅读窗口扩大，视口上方的占位 turn 变成多行，Virtua（`shift={false}`）
推动内容，跟随在每批水合后再拉回一次。测量缓存以行数为键，关闭期间有变化的对话会冷启动。
`scroll-debug-log.ts` 记录显示阻塞原因、跟随修正、显示后与视口相交的隐藏行、行构成和水合窗口
（`window.__lodyScrollLog.dump()`），先证实或否定该假设再改水合路径。显示检查现在也在视口
高度变化时运行，消除了一种面板一直隐藏的路径。

## 验证与限制

`packages/components/tests/use-sticky-scroll.test.ts` 覆盖 Composer 变高与带浏览器夹紧的变矮、
内部滚动元素滚轮、拖滚动条解除与重新跟随，以及锚定全流程（预留、收缩、交给跟随、上滚消耗、
超高消息、发送后视口变高）。components 测试套件通过。桌面与 Web 应用中真实对话的行为尚未验证。
键盘解除只覆盖 PageUp/Home/ArrowUp/Shift+Space。Spec：[对话滚动](../../../../specs/conversation-scroll.md)。
