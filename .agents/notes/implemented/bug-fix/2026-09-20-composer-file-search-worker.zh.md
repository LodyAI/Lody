# 将 composer 文件搜索移出渲染线程

Status: implemented
Translation: current

[English](2026-09-20-composer-file-search-worker.md)

## 摘要

文件提及原先同步匹配全部文件及其目录、排序全部命中项，最后才截取可见结果。
8 万文件的合成项目复现了超过一秒的渲染线程停顿。文件菜单现在通过可取消的 Worker
构建索引和搜索，只发布当前结果，并使用有界选择与仅计算分数的复用缓冲区。
生产构建浏览器测量中，查询最大帧间隔从 1534.3ms 降至 17.7ms；宽泛路径查询仍需
约一秒完成，因此修复的是渲染阻塞，不承诺建议即时出现。

## 决策

`useMentionFileSearch` 管理活跃文件菜单的 Worker，以源条目身份和查询版本约束结果
发布。关闭菜单或更换源会终止 Worker；新输入替换待执行任务并请求取消当前搜索。
Worker 每处理 512 个候选，通过 MessageChannel 让出执行权，接收取消消息，避免
定时器限速。失败显示错误，重开菜单重试，不回退到同步搜索。

Worker 保存规范化路径及预计算片段。最差项位于顶部的堆最多保留 120 个候选，并保留
原排序与同分规则。仅计算分数的 VS Code 变体复用原字符加分逻辑，以滚动类型数组
替代完整矩阵，并先检查是否可能匹配子序列。原位置输出算法、版权、许可证、上游
版本和已有生成署名保留。索引和缓冲区随 Worker 释放，其他提及类别保留各自排序。

防抖只能降低执行频率，列表虚拟化不能消除渲染之前的评分开销。Benchmark 的中间组
表明，即使优化同步算法，宽泛查询仍会阻塞。Worker 引入启动与克隆成本；每个活跃
文件菜单拥有自己的索引，不维护跨项目全局缓存。

[Spec](../../../../specs/composer-file-search.zh.md) 仍为 draft；实现不代表人工批准。
整体提及架构继续由[现有流水线文档](../../../docs/ui-mentions.md)维护。

搜索实现集中于 `mentions/file-search/`，浏览器 benchmark 的运行器和原始样本集中于
`benchmarks/file-search/`。行为测试与 benchmark 共用 `tests/fixtures/file-search/` 中
的冻结基线和合成路径，测试不再依赖 benchmark 入口。

## 可复现证据

[Benchmark README](../../../../packages/components/benchmarks/file-search/README.md)说明命令、数据及方法；
[原始数据](../../../../packages/components/benchmarks/file-search/results-2026-09-20.json)
保留三次重复的全部样本，不丢弃预热样本。环境为 Apple M4 Max、macOS arm64、
Node 26.8.2、Vite 8.2.2、Playwright 1.58.2、无头 Chrome 153。生产构建运行真实 Worker，并将每组结果与冻结的旧实现
逐项比较。

8 万合成文件的完成耗时中位数与最大帧回调间隔：

| 查询             | 基线耗时 | 优化后同步耗时 | Worker 耗时 | 基线最大帧间隔 | Worker 最大帧间隔 |
| ---------------- | -------: | -------------: | ----------: | -------------: | ----------------: |
| `a`              |  442.1ms |         90.4ms |      72.3ms |        451.5ms |            17.7ms |
| `comp`           |  739.7ms |        323.7ms |     316.4ms |        740.9ms |            17.6ms |
| `src/components` | 1530.8ms |        978.2ms |     959.7ms |       1534.3ms |            17.6ms |
| `zz-no-match`    |  741.5ms |         32.5ms |      27.4ms |        746.1ms |            17.4ms |

基线冷索引在渲染线程耗时 215.9ms。Worker 启动、传输、索引及空查询总耗时 210.6ms，
最大帧间隔 17.2ms。

## 安装一致性

CI 最初在测试之前失败：主分支把 Claude adapter 更新到 `56b94c6c`，但没有同步根锁文件。
现已按该 manifest 刷新锁文件。它精确指定的 Anthropic SDK 0.126.0、Prettier 3.9.7、
Vitest 5.0.1（含 Mocker 和 Spy 5.0.1）需要五项版本隔离例外；registry 记录的发布日期
为 2026 年 9 月 15–16 日。这些例外补全已经选定的 adapter 更新，不豁免后续版本。
其余解析仍遵守[七天策略](../process/2026-09-13-dependency-release-age.zh.md)。验证使用
初始化全部固定子模块的独立 clone，包含 frozen-lockfile 安装。

## 验证与限制

在 Node 22.23.2、Vitest 3.2.4 下，17 个相关测试套件的 192 项测试全部通过。
六个搜索/Worker 模块的独立严格类型检查、改动范围 Oxfmt/Oxlint 检查以及 Vite 8.2.2
生产 Worker 构建均通过。在初始化全部固定子模块的独立 clone 中，
`pnpm install --frozen-lockfile`、完整 `pnpm check`（类型、lint、测试与边界）、`pnpm format`、
`pnpm format:check`、`pnpm run docs check` 和完整 Electron `pnpm build` 均通过。
整理后的浏览器运行器也在干净安装环境中通过了结果对齐和真实 Worker 取消验证。
未执行 Electron 界面性能录制。

测试与旧实现比较排序及数量限制，以确定性的 Unicode 和分隔符输入比较上游分数，
并验证查询合并、取消、失败、更换源、关闭重开、卸载、加载分组、首项键盘高亮及实际 composer 插入。
浏览器运行器另行验证真实 Worker 取消后仍能正确查询。

文件枚举、IPC 数据传输、同步草稿恢复及完整 Electron 窗口行为不在本次测量范围。
首次发送索引仍有主线程序列化成本；取消发生在候选批次之间，无法抢占单条异常长路径
内部的评分。这些数据是当前环境下的修复证据，不是普遍延迟上限。
