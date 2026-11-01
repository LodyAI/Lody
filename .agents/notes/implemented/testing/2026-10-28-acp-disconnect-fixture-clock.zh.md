# 显式控制 ACP 断连顺序，保留仓库持久化回调

Status: implemented
Translation: current

[English](2026-10-28-acp-disconnect-fixture-clock.md)

## 摘要

断连提示词的回归测试可能已通过断言，却在关闭离线仓库时超时。原 fixture 根据真实耗时触发持久化让出，再用假 timeout 计时器接住回调；清理时切换时钟便丢掉了回调。这组用例现在让仓库整个生命周期保持真实计时器，并用显式的 prompt、断连信号和 flush 边界覆盖通知尚未写入与已经写入两种顺序。产品行为、原有断言和 30 秒超时保持不变。

## 决定与证据

本次将[原生仓库 fixture 时钟决定](2026-10-27-native-repo-epoch-fixture-clock.zh.md)应用到断连提示词用例。锁定版本 `loro-repo` 0.25.0 的 `DocManager.drainDirtyDocs` 使用 `performance.now()` 计算 5ms 工作预算，仍有工作时会等待 `setTimeout(0)`。fixture 替换了 timeout 计时器，却保留真实单调时钟。`destroyRepoOnRealTimers` 在调用 `repo.destroy()` 前卸载假时钟，丢掉尚未执行的让出回调，而仓库仍持有对应的持久化 Promise。

临时通过 hoisted 注入让单调时钟每次读取递增 10ms，在 SDK 捕获时钟前强制这条路径。原 tool-update 用例的计时器调用栈指向 `DocManager.drainDirtyDocs`；清理进入仓库销毁后触发原有 30 秒超时。[CI run 40630618794 的首次 CLI job](https://github.com/LodyAI/Lody/actions/runs/40630618794/job/122625876973)记录同一用例超时，但没有能证明当时具体阻塞点的调用栈。受控复现证明的是 fixture 缺陷，不能据此断言原 CI 未观测到的细节。

测试不检查耗时，因此保留真实计时器，而不猜测应推进假时钟多久。合成 provider 发出通知后同步取消已排队的批处理 flush，再发送 prompt 已进入信号。测试保留缓冲通知，或显式等待 `flushACPUpdatesNow`，然后才释放 provider 的断连。执行和资源清理均等待其完成 Promise，不使用 sleep、轮询、retry 或更长超时。原有的不重放、未知结果、执行结束、presence 清除断言覆盖三种通知的两种顺序。批处理窗口用例继续使用假时钟。

## 验证与限制

整个文件连续 20 个独立 Vitest 进程通过，每轮 74 项，共 1,480 项。六个显式控制顺序的断连变体在每次递增 10ms 的注入时钟下，另通过五个独立进程；计时器调用栈确认触发了持久化让出。同样条件下，仅去掉真实计时器修复，执行、排空和断言完成后再次触发 30 秒清理超时。注入时钟和诊断日志均为临时实验，不随测试提交。

provider 和 Git 边界仍为合成实现；生命周期事件转发、历史、执行收尾和离线仓库清理保持真实。本地循环与注入时钟的消融验证此 fixture 路径，不代表真实 provider 或桌面包验收。没有改变 Effect 资源归属或迁移边界。
