# 扩展本地用户工作流的桌面 E2E

Status: implemented
Translation: current

[English](2026-09-10-desktop-e2e-journey-expansion.md)

## 摘要

桌面回归套件此前仍缺少消息队列、MCP 目录编辑、重复选择项目、取消外观预览和 Session
已读状态的持久化覆盖。现在新增五条 P1 旅程，通过构建后的 Electron 应用、真实 IPC 图和
bundled CLI 执行这些流程。同时加固已有 Session、Review、MCP、Role、Work 和 Fork 旅程，
让导航、项目注册、Archive 清理和 Session 创建都走可见控件，不再赋值路由或从 renderer
直接写内部状态。最终形成的 14 条场景全部端到端通过。

## 决定与范围

- 将 `LODY-QUEUE-001`、`LODY-MCP-002`、`LODY-PROJECT-002`、
  `LODY-SETTINGS-001` 和 `LODY-SESSION-003` 注册为 active P1 旅程。每条场景拥有
  合成 fixture、精简 Gherkin 步骤、Page Object 交互策略和可观察的清理结果。
- 三条旅程保持为 `runtime-none`：它们使用真实桌面进程树和持久化本地状态，但不启动
  ACP model。队列旅程使用文件信号控制的 ACP 进程，当前 Turn 只有在测试释放后才完成，
  同时可观察实际提交的 prompt mode 顺序。Session 已读状态旅程通过 composer 和 scripted
  ACP provider 创建两个真实 Session。
- 断言持久化结果而不是控制调用：MCP 字段在重开设置后仍存在，项目目录 identity 在
  重复添加后不变，已提交的外观在取消预览后恢复，打开未读 Session 后会恢复历史并清除
  已读标记。
- active registry 行必须使用 null `blockedReason`，quarantined 行必须说明原因，所有非
  null 原因必须包含有效文本，避免候选选择状态与人工排障证据互相矛盾。
- 嵌套侧栏控件自行处理冒泡的键盘事件。用 Enter 激活展开按钮时，应展开或折叠 Opened
  Session，而不是先选择并导航父级行。
- 不通过 IPC 注册项目，不通过 `window.repo` seed Session document，也不通过赋值 route hash
  导航。用户从可见控件完成 provider 配置、发送请求、选择文件、打开侧栏行、调用菜单、
  归档和删除；renderer evaluate 只做只读观察。

本次决定延续[首轮持久化旅程扩展](2026-09-08-desktop-e2e-user-journeys.zh.md)，没有改变
产品意图或协议保证，因此不需要修改 Spec。

## 证据与限制

纠正：最初的 Opened Session 场景直接 seed 两份持久化文档，并通过 renderer repository
设置 `openedBySessionId`，它的聚焦通过没有证明用户旅程。替代的 `LODY-SESSION-003` 使用
composer 创建两个 Session，覆盖已读状态转移，聚焦运行通过。

移除绕过方案后，14 条场景、112 个步骤在 2m01.627s 内全部通过。套件检查器将 14 条 active
场景匹配到 14 个唯一 ID，其中三条 P0、十一条 P1。components 套件通过 446 个文件、3,350
个测试，包括嵌套键盘回归覆盖。
