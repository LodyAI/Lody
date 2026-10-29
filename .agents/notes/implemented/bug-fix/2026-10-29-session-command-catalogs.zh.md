# 将项目命令保留在所属 Session 中

Status: implemented
Translation: current

[English](2026-10-29-session-command-catalogs.md)

## 摘要

同一机器、同一 Provider 下的 Session 原先会替换同一份斜杠命令列表，因此打开另一个项目或刷新能力会同时改变两边的菜单。现在 Provider 探测只提供首次发送前的命令预览，各 Session 通过已有运行配置状态发布自己的实际命令。明确的空列表会清空当前 Session 菜单，尚未报告列表时仍可显示初始预览。这保留了首次发送前的命令入口，无需为草稿启动 Agent 或创建工作区。预览描述的是探测环境，并不代表尚未启动的项目中完整的命令集合。

## 归属与行为

- `AgentClient` 保留 new/load/resume/fork 响应及标准命令通知中的列表。替换运行时会清除前一运行时的观察结果。初始列表通过直接读取状态获取，不伪造 ACP 通知：任何通知都会影响现有的断连提示重放判断。
- 运行配置应用器将已观察到的命令加入已有 Session 更新。缓冲命令通知也使用这条更新路径和所属用户轮次约束。同一个 ACP Session 后续轮次保留命令，更换运行时不继承旧列表。列表整体替换，`[]` 明确表示清空。
- `useAvailableCommands` 优先读取 Session 已报告的列表，包括 `[]`；尚未报告时，读取绑定 Provider 的探测预览。能力刷新更新预览，不替换已报告的 Session 命令。草稿保留发送前的菜单。
- Session 创建后的能力写入不再传入命令。机器写入器在实际写入位置保留最新、运行时匹配的预览，避免读写间隙回滚并发刷新的结果。只有探测会替换预览；探测未提供命令时写入 `[]`。缺少已确认探测列表的条目不能直接满足能力刷新。启动输入的来源记录由探测更新，Session 启动不再更新它。
- 缓存 v11 在读取旧条目时仅移除 v11 之前的命令列表，因为其中可能混有项目数据。模型和其他可理解字段仍可读取，正常能力刷新会替换旧列表。不扫描整个工作区的 Session，也不改写历史记录。

实现沿用现有 Provider 缓存和 Session 控制状态，没有增加项目缓存、计时器、重试循环、草稿预启动或进程管理者。[探测工作区决策](2026-10-25-acp-probe-workdir.zh.md)仍解释探测使用临时目录的原因。本次调整了[能力缓存设计](2026-09-16-acp-capability-refresh-cache.zh.md)中的命令归属，并保留[移除草稿预启动](../simplification/2026-10-16-remove-draft-session-preparation.zh.md)的决定。

本次按 feature/fix 模式评估了原生 Effect 迁移。Agent 启动、Session 控制状态发布和 Repo 仍是尚未迁移完成的 Promise 编排。调整这些纯转换和字段归属不能完成一个原生生命周期单元，因此迁移台账不变。

## 验证与限制

行为测试覆盖启动响应、仅通过通知上报命令的启动、当前与已脱离的 ACP Session、明确空列表、同运行时继续执行、更换运行时、过期轮次拒绝及重复写入幂等性。真实 MachineDocument 写入器验证探测归属、独立强制刷新及空探测结果的缓存。真实 Loro 文档与生产菜单 hook 验证两个项目、客户端同步及刷新隔离。既有的纯元数据轮次测试也验证命令状态发布不会伪造可见 Agent 输出。

对应测试为 `agent-client-authentication.test.ts`、`acp-session-config-applier.test.ts`、`runtime-config.test.ts`、`doc-runtime-config.test.ts`、`session-execution-service.test.ts` 和 `acp-session-runtime-two-client.test.ts`。临时移除 Session 菜单优先级、恢复项目命令写入，两次都使行为回归测试失败。真实桌面交互或重新打包的 Pi 托管运行时仍未验证，当前检查结果记录在 PR 中。
