# Tab 条快速关闭时的宽度冻结

Status: implemented
Translation: current

[English](2026-09-18-tab-strip-rapid-close-widths.md)

## 摘要

桌面端 Session 标签条此前始终将整行宽度均分给可见标签,关闭一个标签后
其余标签立刻重新拉伸,下一个关闭按钮偏离光标。现在标签条实现了 Chromium
的快速关闭模式(`in_tab_close_` / `override_available_width_for_tabs_`):
指针触发的关闭会把每个幸存标签冻结在当前宽度,使下一个关闭按钮恰好落在
光标下;移除以 200ms 过渡滑动收拢、插入从零宽度长入;冻结在指针离开一个
向外扩展的区域(标签条下方 40px、朝新建标签按钮方向 60px)之前一直保持,
而非在条边缘就释放。冻结在离开该区域、新增标签、视口缩到捕获宽度以下或
只剩一个标签时解除。代价是指针悬停期间标签条暂时填不满整行,与 Chrome
一致。

## 决策与依据

行为由 `AdaptiveTabStrip`
(`packages/components/src/components/sessions/adaptive-tab-strip.tsx`)
统一实现,所有使用该组件的地方自动获得。视口内的 `pointerdown` 为一个
手势上膛(带时间戳的 ref);当 `itemIds` 在短暂窗口内收缩时,把上一次应用
布局的逐项宽度捕获进 `FrozenTabStripLayout`,布局 memo 改用冻结表重建各项
宽度,而不再调用 `allocateAdaptiveTabStripLayout`。移除差异在 RENDER 期间
判定——React 的派生状态调整模式,以上一次 commit 的
ids/选中项/视口为准——因此移除 commit 的第一个绘制帧就已经是冻结宽度。
早期版本在 `useLayoutEffect` 里决定冻结:移除渲染先把新分配的宽度提交到
DOM,effect 才装上冻结,第二次渲染再写回——两次 commit 之间若有样式重算
(子组件的测量 layout effect、observer 读取)就会以未冻结宽度为过渡起点,
让幸存项闪一帧错误宽度。同一个 render 阶段代码块计算滑动 margin 与进入
宽度,一律用直接值而非 updater 函数,StrictMode 双重渲染不会叠加。

语义对照 `chrome/browser/ui/views/tabs/tab_strip.cc` 与
`tab_container_impl.cc`:

- 仅指针触发的移除才进入(等价 `CloseTabSource::kFromMouse`):pointerdown
  上膛意味着指针悬停时的键盘或程序化关闭走正常重排,不会误冻结。
- 连续移除保持同一组冻结宽度,反复点击持续有效。冻结只在进入时要求上膛;
  已进入后,区域内的移除无需再次上膛。
- 退出由指针位置驱动,采用 Chromium `MouseWatcher` 的区域——标签条边界
  向下扩 40px、向新建标签按钮方向扩 60px——因此移向 `+` 或略微下移不会在
  手势中途重新拉伸。窗口级 `pointermove` 监听在指针离开该区域时解除冻结。
- Chromium 的可用宽度是 `min(override, real)`:视口变宽时保留捕获宽度;
  变窄时在下一个 commit 解除。
- 只关闭最后一个标签永远不进入该模式——新末标签的右缘本来就在原位置。
  Chromium 也不会因末尾移除而收缩冻结预算,因此冻结状态下关闭最后一个
  标签会把幸存项重新分摊到已占用的宽度上,使新末标签的右缘(也就是它的
  关闭按钮)保持在光标下。
- 只剩一个可见标签时 Chromium 直接退出关闭模式;唯一的幸存者立即铺满
  整行。
- 冻结期间重排按 id 保留捕获宽度并应用新顺序。
- 宽度按角色冻结而非严格按 id。Chromium 在关闭活动标签时按继任标签宽度
  补偿(`size_delta = next_active_tab->width()`),因此捕获在逐项表之外还
  记录活动与非活动宽度:冻结期间变为活动状态的幸存者取得捕获的活动宽度,
  先前的活动标签回落到非活动宽度。由于"关闭 + 重新选中"可能在同一次
  commit 到达,决定冻结布局中活动宽度归属的是上一次 commit 的活动 id
  (从 ref 读取),而不是当前 prop。

动画对齐 `BoundsAnimator` 的 200ms。移除时,每个被删槽位之后的第一个幸存
项以"被释放宽度 + 间距"作为 `margin-inline-start` 起始值并缓动到 0,视觉
上等价于空隙在后续标签脚下塌陷;插入的标签从零宽度长到分配宽度。两者都是
CSS 过渡——施加后一帧再重定向到终态——因此 `motion-reduce` 用户跳过动画
直接得到最终几何,dnd-kit 拖拽时的内联 transform 过渡仍然优先。被关闭的
标签本身不会保留在 DOM 中做收缩动画(Chromium 会在模型中保留它并收缩),
所以我们的滑动是近似而非逐帧复刻。

动画清理修正:重定向到终态时清空临时 margin 表;缺失条目渲染为零,
CSS 继续完成过渡。此前保留值为零的条目会在每帧重建非空 Map,
导致关闭中间标签后 effect 与 React commit 持续触发。

两处细化让插入动画不越界。同一 commit 内既删又增属于"替换"而非"插入"
——草稿提升为 Session、或被关标签自动替补出的草稿——此时新项从最近的
被删项宽度渐变,而不是从零出现(否则会读成"自动选中的继任标签从无中生
有")。此外,向空 strip 中加入的唯一标签完全跳过动画,直接以最终宽度渲
染:没有相邻几何时,长入只会看起来像凭空物化。

## 备选方案

基于时间的解除(每次关闭后延迟重扩)被否决:桌面版 Chromium 没有定时器——
它在鼠标离开时退出——延迟要么显得武断,要么在仍悬停的光标下重扩,重新
引入本特性要消除的移动靶。让被关闭标签的"幽灵"保持挂载以播放自身收缩动画
被否决:可排序项嵌在 `DndContext`/`SortableContext` 内,注入占位子节点会与
拖拽层冲突,而相对滑动方案的视觉收益有限。用 WAAPI keyframes 做滑动被否决:
jsdom 没有 `Element.animate`,该行为将无法测试;状态驱动的 margin 在测试中
走同一条路径。

## 验证

`packages/components/tests/session-tab-bar.test.tsx` 新增 rapid-close 套件
(jsdom,mock `clientWidth` 与 `ResizeObserver`):中间关闭冻结、扩展区域
内外的 slop 边界、连续关闭、幸存项滑动 margin、未冻结的末标签立即重排、
冻结态末尾关闭的重新分摊、单幸存者释放、视口变大保留/变小解除、未上膛的
程序化关闭、活动关闭后的角色提升、插入生长动画、替换项从被删宽度渐变、
空 strip 单标签直入,以及一个 MutationObserver 回归——断言移除 commit 上
活动项的内联宽度从不持有未冻结值——24/24 通过,另有 7 个既
有的 `adaptive-tab-strip` 分配器测试一并全绿。快速关闭套件使用手动推进的
动画帧队列;滑动回归同时验证最终几何与后续帧不再产生 React commit 或
待执行回调,该断言在原清理逻辑下失败。行为也在真实浏览器中对照
Storybook(`Sessions/SessionTabBar → Rapid Close`)验证:关闭中间标签后
幸存项冻结;冻结在 40px/60px slop 区域内保持、区域外解除;冻结态末尾
关闭时幸存项重新分摊且新末标签右缘(≈993px)保持在光标下;
`document.getAnimations()` 捕获到幸存项的 margin-inline-start
CSSTransition;新标签从 `width: 0px` 长入。`tsgo --noEmit` 对改动文件无诊断;该嵌套
worktree 中包内仍有与本改动无关的既有 Electron 类型缺失报错。尚未在运行的
桌面构建中实测。
