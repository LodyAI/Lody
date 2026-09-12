# 将桌面 E2E 扩展为五条跨功能矩阵

Status: implemented
Translation: current

[English](2026-09-12-desktop-e2e-user-journey-expansion.md)

## 摘要

五条 P1 旅程现在验证跨功能矩阵，而不是孤立的 happy path。每条矩阵都让同一份用户状态
穿过多个产品界面、renderer 重载、负向状态、跨 Session 隔离和 UI 清理。旅程通过构建后的
Electron 应用、真实 IPC、bundled CLI 和确定性 ACP provider 操作可见控件。附件矩阵还守护
一个本地模式缺陷：云端 token 错误地阻断了 Electron 文件直传。active registry 现在包含
21 条场景，同时 Cucumber dry-run 会在启动 Electron 前拒绝歧义或缺失的步骤。

## 决定

| 旅程                  | 交互维度                                                                   | 负向与隔离证明                                                           |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `LODY-SEARCH-001`     | 三种标题、部分/大小写查询、重命名重建索引、重载、归档、删除                | 空结果排除全部标题；归档/删除只移除目标，相似结果仍可搜索                |
| `LODY-ATTACHMENT-001` | 取消选择、附件加提示、纯文本后续轮次、重载、归档恢复、双 Session           | 取消后不能发送；下一轮和第二个 Session 都不能继承附件                    |
| `LODY-GOAL-001`       | capability 门控、双 Session、暂停、更新、恢复、重载、清理、归档恢复        | 非法控制不可见；独立 Session 没有目标快照或目标 wire 事件                |
| `LODY-AGENT-001`      | 无效草稿、创建、取消编辑、保存重命名、双 Provider、重载、双 dispatch、删除 | 无效或取消状态不能进入目录；两个 Session 分别提供命令和提示证据          |
| `LODY-CONTEXT-001`    | 用户/助手前缀、富 Markdown、重载、流式导出、完成、取消、双 Session         | 前缀排除后续轮次与原生 fork 目标；取消 Session 的导出排除主 Session 历史 |

- 场景专用状态由各 step 模块持有，不扩展共享 Cucumber World。每条旅程使用模块级
  `WeakMap`；fixture 只持有合成 provider 信号和标识符。
- 将 renderer 重载作为持久化重建边界。当前 harness 会在 Electron 退出时删除隔离数据目录，
  因此这些场景不声称验证完整进程重启后的持久化。
- 使用明确协议或文件事件释放挂起的 provider turn。矩阵不依赖 sleep、调度时机、真实模型
  或网络服务。
- 本地文件直传不依赖云端认证。workspace 始终必需；只有本地传输不可用或失败、调用方需要
  改走云端上传时，才要求 authentication token。
- 在 `e2e:check` 中 dry-run 全部 Cucumber feature bindings。除了 registry metadata 和
  TypeScript 契约之外，重复或缺失的步骤短语也会提前失败。

本次决定延续[上一轮工作流扩展](2026-09-10-desktop-e2e-journey-expansion.zh.md)。它恢复既有
本地附件意图并增加验证覆盖，没有改变产品保证，因此不需要修改 Spec。

## 证据与限制

生成的 coverage 和 suite contract 将 21 条 active scenario 对应到 21 个唯一 ID，其中四条
P0、17 条 P1。Cucumber 静态解析覆盖 223 个步骤。一次组合真实 Electron 运行在 58.764 秒内
通过五条矩阵旅程及其 94 个步骤；完整串行回归在 197.656 秒内通过 21 条场景和 223 个步骤，
没有失败。确定性 ACP provider 可以证明本地产品集成和协议行为，而不把外部模型或网络
可用性变成合并条件。
