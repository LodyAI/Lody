# 文件树测试拥有自己的滚动时钟

Status: implemented
Translation: current
PR: [#1252](https://github.com/LodyAI/Lody/pull/1252)

[English](2026-10-04-file-tree-scroll-test-clock.md)

## 摘要

组件 CI 分片的 1701 个断言全部通过，却在 jsdom 销毁后因未处理的 React 更新失败。
文件树滚动测试把虚拟列表的滚动结束防抖回调留在了真实时钟上。该套件现使用假时钟，
显式验证滚动结束，并在恢复真实时钟前执行剩余回调。运行时行为不变。

## 证据与决策

[失败的 CI job](https://github.com/LodyAI/Lody/actions/runs/37202036948/job/111435612581)
表明 `file-tree-virtual-rows.test.tsx` 销毁环境后，TanStack Virtual 的防抖 offset
observer 调用 React 状态更新，触发 `window is not defined`。Virtual-core 3.13.23
移除了滚动监听器，却没有取消该定时器。本地单独运行原测试通过，符合收尾时序竞争的表现。

既有滚动测试现在推进假时钟，检查滚动结束后的挂载窗口仍非空、大小有界且保持滚动位置。
清理阶段先卸载 React root，再在 jsdom 仍存在时执行剩余定时器。这遵循
[模块图决策](2026-09-10-components-test-module-graph.zh.md)保留的逐文件清理边界，
没有关闭 Vitest 未处理异常报告，也没有增加 sleep。

## 验证

聚焦文件树套件的七项测试通过。对应组件分片（`--maxWorkers=4 --shard=1/3`）的
185 个文件、1701 项测试全部通过，没有未处理异常。定向格式及 diff 检查通过。
当前工作树缺少依赖，根检查仍因缺少工具阻塞；验证在具有依赖的独立副本中执行。
