# CI 测试汇总保留取消状态

Status: implemented
Translation: current

[English](2026-10-13-ci-test-summary-cancellation.md)

## 摘要

被新运行取代的 PR 运行，可能在同一 head 已完整通过后仍留下失败的 `Tests` 检查。汇总使用 `always()`，所以工作流取消后仍用 `RESULT=cancelled` 执行仅成功可通过的断言。将汇总作业条件改为 `!cancelled()`，保留全部测试分组必须成功的严格检查。真实失败和意外跳过仍失败；取消不变成测试成功，也不改写历史检查。

## 证据与边界

取消的 Lab run38363006126 在汇总 job115181431735 中打印 `Test groups: cancelled` 并退出1；同一 head008ef773 的 CI38363006130 已完整成功。当前1474、1485、1491、1493、1496和1526检查存在同类取消汇总红项。代码/测试的绿运行仍单独归属；不为隐藏取消汇总而重跑旧 E2EE 矩阵。

[GitHub 状态文档](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions) 建议用 `!cancelled()` 在成功或失败后继续、同时排除取消的工作流。保留既有 `needs.test-groups.result == success` shell 检查、只读权限、并发取消和 required check 名称。不改 token、checkout、缓存、部署或分支保护。作业条件由 GitHub 判断，本地 shell 用例和正常绿 CI 本身不能证明实际取消已经验证。历史失败/取消记录仍保留，后续新执行才可能取代；不自动合入或修改历史检查。
