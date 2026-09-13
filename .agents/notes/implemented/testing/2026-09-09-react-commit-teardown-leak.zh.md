# act 之外的 React commit 会让下一个测试文件所在的整轮运行失败

Status: implemented
Translation: current

[English](2026-09-09-react-commit-teardown-leak.md)

## 摘要

`tests/mobile-chat-list-preview-cap.test.tsx` 通过 `flushSync` 而非 `act` 完成渲染与卸载的
commit，这会把 React 的 passive-effect flush 留在真实的宏任务队列上。该回调在做任何事之前都会
先读取 `window.event`，因此当 Vitest 先一步拆除该文件的 jsdom 环境时，它会以未处理错误抛出，
让一轮 3313 个测试全部通过的运行失败。现在该文件的每次 commit 都走 `act`，其 teardown 会 await
一次 `setImmediate`，使 React 排入队列的任何东西都不会比它所期望的 DOM 活得更久。同样的
`flushSync` 模式还出现在几十个其他套件中，因此本次修复的是输掉这场竞态的那个文件，而不是整个
类别；全套件的排查仍然待办。

## 决策

让每次 commit 都走 `act` 并设置 `IS_REACT_ACT_ENVIRONMENT`，这正是该包中另外 148 个套件已有的
做法。`act` 会在测试内部排空 passive effect，因此根本不会为它们创建调度器回调。

仅此还不够：每个测试仍有一次 commit 逃逸，留下一个排队回调。与其在这个文件只做观察的组件树里继续
追查游离更新，不如让 teardown 在卸载后 await 一次 `setImmediate`。宏任务队列是 FIFO，因此在它之前
入队的每个回调在它 resolve 时都已执行完毕——这是顺序屏障，不是 sleep，也不是真实时钟竞态。两部分
缺一不可：`act` 确定性地消除了绝大部分，屏障则收口剩余部分。

## 证据与限制

该失败模式是被刻意复现的：把该文件复制一份，加上一个删除 `globalThis.window` 后再让宏任务队列运行
的 `afterAll`——以此代表 Vitest 的 teardown 赢得竞态——结果报告了三个
`ReferenceError: window is not defined` 未处理错误，与
[CI run 34323149523](https://github.com/LodyAI/Lody/actions/runs/34323149523)
是同样的错误、同样的文件。把 commit 移入 `act` 后降到一个；加上 teardown 屏障后降到零，九个测试
仍然全部通过。同一探针作用于已经 await `act` 的 `tests/markdown-mermaid-fullscreen.test.tsx` 时
无任何报告，一个在 `act` 内渲染并卸载的最小 fixture 同样无报告——因此该泄漏是「在 `act` 之外
commit」的属性，而不是 React 卸载本身的属性。

限制：CI 失败本身从未在本地复现——无论 8 个 worker 还是 2 个、是否绑定到单核；探针是对该竞态的
刻意模拟，而非竞态本身。那次在 `act` 之下仍然存活的游离 per-test commit 未能追溯到来源——调度器
在测试文件能够插桩之前就捕获了 `setImmediate`——因此由屏障兜底。另有几十个套件通过 `flushSync`
提交并仍处潜伏状态；它们今天是绿的，只是因为其排队回调通常在 teardown 之前就跑完了。

相关：[Mermaid 图手势](../bug-fix/2026-09-09-mermaid-diagram-gestures.md)，其 pull request 因为
改变了测试时序而暴露了本问题。
