# 将桌面 E2E 扩展为五条跨功能矩阵

Status: implemented
Translation: current

[English](2026-09-12-desktop-e2e-user-journey-expansion.md)

## 摘要

五条 P1 旅程现在验证跨功能矩阵，而不是孤立的 happy path。每条矩阵都让同一份用户状态
穿过多个产品界面、可见 UI 重访、负向状态、跨 Session 隔离和 UI 清理。旅程通过构建后的
Electron 应用、真实 IPC、bundled CLI 和确定性 ACP provider 操作可见控件。附件矩阵还守护
一个本地模式缺陷：云端 token 错误地阻断了 Electron 文件直传。active registry 现在包含
21 条场景，同时 Cucumber dry-run 会在启动 Electron 前拒绝歧义或缺失的步骤。

## 决定

| 旅程                  | 交互维度                                                                 | 负向与隔离证明                                                           |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `LODY-SEARCH-001`     | 三种标题、部分/大小写查询、重命名重建索引、UI 重访、归档、删除           | 空结果排除全部标题；归档/删除只移除目标，相似结果仍可搜索                |
| `LODY-ATTACHMENT-001` | 取消选择、附件加提示、纯文本后续轮次、UI 重访、归档恢复、双 Session      | 取消后不能发送；下一轮和第二个 Session 都不能继承附件                    |
| `LODY-GOAL-001`       | capability 门控、双 Session、暂停、更新、恢复、UI 重访、清理、归档恢复   | 非法控制不可见；独立 Session 没有目标快照或目标 wire 事件                |
| `LODY-AGENT-001`      | 无效草稿、创建、取消编辑、保存重命名、双 Provider、Settings 重访、双派发 | 无效或取消状态不能进入目录；两个 Session 分别提供命令和提示证据          |
| `LODY-CONTEXT-001`    | 用户/助手前缀、富 Markdown、UI 重访、Stop、完成请求、双 Session          | 前缀排除后续轮次与原生 fork 目标；取消 Session 的导出排除主 Session 历史 |

- 场景专用状态由各 step 模块持有，不扩展共享 Cucumber World。每条旅程使用模块级
  `WeakMap`；fixture 只持有合成 provider 信号和标识符。
- 每个产品状态迁移都由可见控件、键盘输入或用户触发的文件选择器驱动。fixture 只模拟
  provider 并记录协议证据，不修改产品状态，也不释放挂起的 turn。矩阵不依赖 sleep、
  调度时机、真实模型或网络服务。
- 将嵌套菜单关闭视为用户可见的状态迁移。Agent Provider 旅程会等待运行配置菜单和 Agent
  子菜单都报告展开，使用 `Escape` 逐层关闭仍打开的菜单，并在下一次点击前等待根 trigger
  报告关闭。测试不强制点击，也不通过 renderer 内部状态触发选择。
- 本地文件直传不依赖云端认证。workspace 始终必需；只有本地传输不可用或失败、调用方需要
  改走云端上传时，才要求 authentication token。
- 在 `e2e:check` 中 dry-run 全部 Cucumber feature bindings。除了 registry metadata 和
  TypeScript 契约之外，重复或缺失的步骤短语也会提前失败。

本次决定延续[上一轮工作流扩展](2026-09-10-desktop-e2e-journey-expansion.zh.md)。它恢复既有
本地附件意图并增加验证覆盖，没有改变产品保证，因此不需要修改 Spec。

## 证据与限制

生成的 coverage 和 suite contract 将 21 条 active scenario 对应到 21 个唯一 ID，其中四条
P0、17 条 P1。Cucumber 静态解析覆盖 223 个步骤。一次组合真实 Electron 运行在 59.290 秒内
通过五条矩阵旅程及其 94 个步骤；完整串行回归在 199.995 秒内通过 21 条场景和 223 个步骤，
没有失败。确定性 ACP provider 可以证明本地产品集成和协议行为，而不把外部模型或网络
可用性变成合并条件。

三个 macOS PR run 在 head `299d06f7`、`396b379c` 和 `723237b2` 上暴露了 Agent 菜单竞态。
第一次修正让嵌套菜单的打开和关闭变得可观察，并在本地通过三轮全新的 focused 运行，但下一次
远端 trace 显示了剩余原因：Playwright 将指针从 Agent trigger 一次性跳到向左展开的子菜单。
子菜单在命中测试期间关闭，根页面因而拦截点击，Provider 项也随之从 DOM 脱离。Provider 选择
现在让真实指针经过中间位置、再次断言可见的子菜单状态，再执行语义化的选项点击。它不强制
点击、不通过 renderer 内部状态派发选择、不重试工作流，也不依赖延时。三轮全新的 focused
运行均通过全部 18 个步骤，且 `pnpm --filter @lody/e2e check` 通过。按明确要求，本次修正未在
本地重跑完整 Electron suite。
