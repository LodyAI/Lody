# 受控的 Inbox 人工恢复

Date: 2026-10-21
Status: implemented
Archived: 2026-10-29
Translation: current
PR: [#1778](https://github.com/LodyAI/Lody/pull/1778)

[English](2026-10-21-manual-inbox-recovery.md)

## 摘要

旧 Inbox owner 的资源释放无法确认时，会阻止后续所有输入。第一阶段通过现有的持久化聊天错误显示这一状态，并提供绑定状态快照的离线人工恢复流程，覆盖活动 execution 指针缺失的情况。恢复必须取得 Host 独占权、检查已记录资源，并由操作者明确确认未记录资源也已释放；保留排队输入和结果，不重放结果未知的请求。Windows 自动恢复仍被推迟，因为根 PID 消失不能证明后代进程已经退出。

## 决策与证据

[既有 Inbox 实现](../../implemented/architecture/2026-10-12-operation-inbox.zh.md) 已有启动资源探测和离线 recover-inbox 命令，不是遗漏了启动扫描。自动探测有意拒绝 Windows 身份记录，因为现有 PID 日志无法证明整个进程树消失。[#1770](https://github.com/LodyAI/Lody/issues/1770) 中最初为何缺少释放回执仍未知，本次不声称修复该起因。

本次解决三个缺口：

- admission 拒绝发生在普通可见回合错误处理之前。现在仅在重新读取并确认 blocked 后，才写入持久化 chat_failed，包含准确目标和仅检查命令；其他拒绝保持原有语义。变为终态的被拒绝输入按精确 ID 退役，但不能改变 ID 恰好相同的活动输入。admission 失败不得释放从未取得的 execution，包括重启后的确定性 ID 碰撞。
- blocked=1、active_execution=NULL 原本被 execution/resource 联表遗漏。检查现在覆盖它和该 Session 的所有未释放资源记录；专门的 --orphan <snapshot> 路径不伪造 execution ID，也不把 NULL 当作释放证据。
- 普通 Stop 的 pause helper 会把所有待处理输入取消并标记为 user_stop。人工恢复改为仅结束状态不明的活动/已提交输入，保留其他排队输入，将仅 prepared 的结果 claim 归还为暂存结果，然后暂停。聊天历史不删除，submitted/unknown batch 永不重放。

## 权限、事务和故障隔离

命令必须在目标机器、账号和数据根目录下、Agent 会话之外运行。带作用域的 Host lease 在访问数据库前排除仍运行的 desktop/daemon。检查使用只读连接，验证 schema 兼容性，不执行迁移。修改必须提供检查得到的 token，并明确确认全部旧资源释放。只观察、不终止已知根进程；进程仍存活、探测失败/不确定、跨平台身份或归属歧义都继续 blocked。

SHA-256 token 覆盖排序后的 Session 归属、未完成资源日志、输入、batch、intent 和 Host owner 事实。探测后，写事务在 BEGIN IMMEDIATE 内再次比较。新输入、owner 或资源 acquisition 会使旧操作失效。Host 激活时递增 blocked Session 的 revision，每次资源注册递增日志 generation，防止值改变后恢复原样仍复用旧 token。旧 v2 日志只读投影为 generation=0，不因检查而写入。暂停、资源释放、不确定输入退役和独立的可空 execution 恢复审计在同一事务提交，任何写入失败均回滚。重复已经完成的请求仅返回“不再 blocked”，不再修改或产生新释放。

恢复仅影响该 blocked Session，不增加后台 worker 或持久化确认门槛，不制造正常释放 wake。重启后新的用户输入或 Agent-chat 输入均会清除现有 pause，因此不是只允许人工恢复的停止屏障。暂停期间到达的结果继续暂存。保留原生 Effect 工作流和有作用域的平台边界，不扩展到无关的 Session/ACP 迁移。

## 更正：admission 等待启动探测

后续一次事故暴露了错误的人工恢复提示。主机在回合进行中重启，重启后的 daemon 在启动后 15 毫秒内重新 dispatch 了被中断的用户回合。此时启动探测尚未读取进程表，admission 读到 blocked=1，于是显示退出并运行 recover-inbox 的指引；数秒后同一探测已证明旧根进程消失并解除了 blocked。现在桥接层的 admission 在读取 blocked 状态前先等待这次一次性探测。被中断的输入随后按普通被拒绝输入结束、不重放，新输入正常执行；探测失败时 blocked 仍交由既有路径处理。代价仅是启动后的首次 dispatch 多等待一次本地进程表读取。合成测试会挂起探测，并在其完成前覆盖上述两种情况。

## 验证与限制

提供合成 SQLite、进程探测、Host lease、命令和持久化历史测试，覆盖缺失/不完整日志、orphan、存活根进程/Host、快照变化、unknown 不重放、队列/结果保留、回滚及重复恢复。测试 POSIX 参数往返和 PowerShell 引号。本执行环境无法绑定测试用临时 Host socket，因此相关集成测试尚未验证，不绕过独占检查。原生工作流/SQLite 测试使用明确注入的 port，不声称证明 OS lease。验证平台为 Linux，没有恢复真实用户数据库、运行中的 daemon 或原生 Windows 进程树。[Windows 隔离方案](../../proposed/architecture/2026-10-21-windows-inbox-containment.zh.md) 单独记录第二阶段及其验收条件。
