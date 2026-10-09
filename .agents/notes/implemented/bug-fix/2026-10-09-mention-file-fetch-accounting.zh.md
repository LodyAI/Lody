# 在共享请求层统计文件 mention 失败

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1359

[English](2026-10-09-mention-file-fetch-accounting.md)

## 摘要

仓库文件树请求已合并，但各挂载中的 mention hook 会分别上报同一次拒绝。
现在由请求归属层通知一个失败观察者，各消费者仍保留失败状态，后续尝试仍能重试。
同时修复 GitHub 类型化认证错误和 HTTP 429 分类，以及切换仓库失败时残留旧仓库路径。
这些缺陷有代码证据，但不能证明生产发生接口事故，或解释其占汇总事件的比例。

## 证据与决策

[此前缓存决策](2026-09-23-portal-full-restyle.md#follow-up-reductions)引入内存、
IndexedDB 与 in-flight 合并；各 hook 的 catch 仍单独上报，PostHog 对象也在获取
副作用依赖中。菜单关闭时，草稿 hydration 仍获取文件树。GitHub 获取包含元数据、
ref 和递归树读取，现有 token 管理器遇到类型化 401 会重试一次，所以逻辑尝试不等于
单次 HTTP 请求。

缓存采用第一个失败观察者，包括文件浏览器先请求、mention 后加入的情况。
消费者卸载不取消通知；观察者抛错不替换原始失败。失败不缓存；重新挂载或来源变化
重试，分析客户端身份变化不重试。不新增冷却期、后台定时器或菜单重试入口。
保留缓存新鲜度和主动 hydration。不采用采样，因为会隐藏独立失败；不改为仅开菜单
才获取，因为这会改变 hydration 行为。

实际 GitHubAuthError 的默认文案没有数字状态码，也没有原分类器识别的认证关键字。
HTTP 429 也漏分。现已修复，仍不发送原始错误文案。平台遥测禁用保持不变。
[草案契约](../../../../specs/mention-file-fetch.zh.md)说明计数和重试边界。

## 验证与限制

缓存与 hook 定向套件共 9 项测试通过。合成测试覆盖并发拒绝、单观察者、请求耗时、同错误对象的新尝试、恢复、过期缓存
保留、观察者异常隔离、hook 卸载、分析客户端变化及切换仓库失败。
不包含原始生产事件、私有源码或对话。汇总数据无法区分消费者放大、重新挂载频率、
认证失败、限流与网络或服务故障；生产归因仍需事件明细及部署后验证。

组件全套通过：557 个文件、4,938 项测试。
根 `pnpm check` 的类型检查和 lint 通过，随后停在未修改的 CLI 原生递归子模块
测试（Git wrapper 返回 `context_unreadable`；CLI 3,645 项测试通过）。
`pnpm format`、i18n、Code Collab 导入、平台与公开边界，以及
`pnpm run docs check` 均单独通过。
