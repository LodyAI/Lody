# 恢复迟到测量后的初始滚动位置

Status: implemented
Translation: current

[English](2026-09-23-initial-scroll-recovery.md)

PR: [#896](https://github.com/LodyAI/Lody/pull/896)

## 摘要

会话行已经挂载并完成测量时，整个消息区仍可能一直不可见。冷启动恢复缓存像素位置时，
浏览器会先按估算滚动范围截断位置；Virtua 的滚动请求结束后，迟到的测量又会修正锚点。
初始显示门槛只等待位置回到缓存目标，却没有继续恢复它。现在滚动适配器在几何变化和
滚动事件中持续应用截断后的目标，直到满足显示条件，同时保留测量门槛并尊重新的导航。
这复现并修复了一条永久空白路径；原报告的运行时现场已经丢失，无法证明它必然走了此路径。

## 原因与职责

[窗口读取决策](../architecture/2026-09-10-windowed-reader-integration.zh.md)要求目标行完成
测量后才显示，这一要求保持不变。此前 `use-sticky-scroll.ts` 只调用一次 Virtua 的异步
`scrollTo`，随后仅比较当前位置与缓存目标。Virtua 0.49.1 的请求在 150ms 内没有新测量
时结束。稍后到达的测量可能改变最大滚动范围并补偿可见锚点，此时没有任何一方会再恢复
显示门槛要求的位置。

[后台加载修复](2026-09-22-background-hydration-render-window.zh.md)另行稳定显示后的行集合；
本次处理的是初始位置恢复，两者互补。

缓存像素位置恢复现在与尾部修正一样，使用 sticky 库的 DOM setter。在 Virtua 确认偏移且
目标行完成测量之前，几何和滚动回调会重新应用当前截断目标。不增加重试定时器、无条件
显示、额外观察器或消息子树扫描。显示后，旧目标不再控制滚动；显示前点击回到最新、
向上滚轮意图和受抑制的显式跳转也会取消旧目标。移除异步初始请求同时防止它撤销新跳转。

## 证据与边界

- 独立浏览器用例使用实际 hook、真实 Virtua、30 行合成内容及 1200px 的缓存位置。
  暂停行测量，令待处理滚动请求结束，再释放测量后，旧代码停在 7235px，行已测量但
  仍然隐藏；修复后恢复到 1200px 并显示。
- `tests/use-sticky-scroll.test.ts` 覆盖截断范围及锚点变化、虚拟列表偏移确认、测量门槛
  和导航接管。迟到测量回归在旧 hook 上失败。
- `ColdCachedOffset` 与 `tests/e2e/session-chat-hydration.spec.ts` 保留使用受控
  ResizeObserver 和虚拟时钟的浏览器复现。冷尾部用例每次打开都清除位置及测量缓存：
  热缓存已经提供测量，因此要求它继续隐藏并不正确。
- 报告还包含传输错误，但与空白的因果关系未经证实；本次不改变传输恢复机制。

当前职责与约束见 [hooks README](../../../../packages/components/src/hooks/README.md#conversation-scrolling-use-sticky-scrollts)
及 [hooks 规则](../../../../packages/components/src/hooks/AGENTS.md)。

## 验证

基于已包含后台加载修复的主分支，五组相关单元测试共 69 项通过；Chrome 中完整的
`session-chat-hydration.spec.ts` 浏览器测试共 7 项通过。新浏览器测试在旧 hook 上失败，
原因是释放测量后仍然隐藏。组件类型检查、范围内的类型感知 lint（零错误）及仓库格式化
通过。完整 `pnpm check` 停在 `site-docs` 缺失依赖；全库 lint 也遇到未安装模块的类型
声明缺失。文档检查仍有现存的子模块链接缺失。
