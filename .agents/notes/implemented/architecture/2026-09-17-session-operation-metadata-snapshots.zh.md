# 从 Repo 元数据发现 Session 操作目标

Status: implemented
Translation: current

[English](2026-09-17-session-operation-metadata-snapshots.md)

## 摘要

渲染器元数据投影即使已完成初始水合，也可能落后于 Repo，导致生命周期操作遗漏后代。
归档、恢复及已归档根会话删除现从绑定 workspace 的同一份 Repo 快照发现目标，
前提是所选元数据源已就绪。既有关系规则保持不变，桌面本地操作不要求云端连通。
发现失败不产生写入；写入途中失败保留可见的部分状态，不以元数据回滚冒充运行时或
工作树清理的可逆事务。

## 决策与职责

[关系 Spec](../../../../specs/session-relations.md) 拥有操作语义。
[共享读取入口](../../../../packages/shared/src/session-operation-targets.ts) 通过一次
仅含元数据的 `repo.listDoc` 查询，以文档 room id 确定身份并排除删除标记。
根验证与后代选择使用同一份结果，不读取或回退到 UI atom。

| 操作                    | 快照目标                                            |
| ----------------------- | --------------------------------------------------- |
| 归档                    | 根及沿包含关系、精确 opened-by 关系递归可达的后代。 |
| 恢复、已归档根会话删除  | 根及直接包含的子会话。                              |
| 精确删除、普通 Tab 关闭 | 不发现关系目标，不要求全局 readiness。              |

[runtime](../../../../packages/components/src/providers/create-workspace-runtime.ts)
在所选元数据源首次同步完成前、或销毁后拒绝读取。桌面本地使用 local transport，
不以云端连通或 UI 水合作为前提。
[Session actions](../../../../packages/components/src/hooks/use-session-actions.ts)
在异步发现目标和恢复验证之后、写入之前检查当前 runtime 身份；
开始写入后固定使用已捕获的 writer 和目标集。
CLI [命令](../../../../apps/cli/src/commands/session.ts) 的三个操作均在发现前同步，
包含降级初始化后的 workspace 解析阶段，并保留写后同步确认。

快照指适用 readiness 边界后在该 Repo 中观察到的元数据，不包括后续创建或离线副本。
没有新增关系索引、历史水合、daemon 命令或跨 Session 事务。

## 失败与恢复

数据源未就绪、查询失败、根缺失或已删除，都在写入及终端关闭前拒绝操作。
归档仍顺序幂等写入，后续失败可能留下之前已成功的状态；重试已归档根会重新发现后代。
终端关闭在各次归档写入成功后尽力执行。永久删除先处理直接子会话，再处理根，
因此子会话删除失败时根仍存在。

[状态驱动清理决策](2026-09-11-session-worktree-reconciliation.zh.md) 继续定义 daemon
资源清理：恢复元数据不能重建已停止的运行时或撤销工作树清理。若要求进程退出后仍必定
完成操作，需要另外定义持久化操作协议，超出本次目标发现修复。

## 证据与替代方案

[#663](https://github.com/LodyAI/Lody/pull/663) 及其
[归档决策](../bug-fix/2026-09-13-session-archive-descendants.zh.md) 通过拒绝未完整的 UI
缓存修复冷归档，却留下恢复缺口。
[投影实现](../../../../packages/components/src/atoms/doc-meta.ts) 延后分批发布后续 Repo
事件，因此 ready 缓存也可能滞后。此前基于 `e11be6b8` 的合成回调探针复现了两类遗漏。

补恢复检查或采用 [#577](https://github.com/LodyAI/Lody/pull/577) 的缓存等待方式，
仍保留实时投影滞后。未合并的 [#658](https://github.com/LodyAI/Lody/pull/658)
提供了 Repo 查询方向，但其仅按包含关系归档的规则早于 #663，补偿也不能撤销资源停止。
本决策只替换发现边界，不改变恢复和删除保留的
[包含关系规则](../bug-fix/2026-09-10-session-containment-lifecycle.zh.md)。

## 验证与限制

既有 [action 套件](../../../../packages/components/tests/use-session-actions.test.ts)
和 [CLI 套件](../../../../apps/cli/src/commands/session.test.ts) 验证真实 Repo 状态、
UI 投影滞后、删除条目、规范身份、读取或同步失败、workspace 切换、部分写入、重试及
不变的级联范围。[runtime 套件](../../../../packages/components/tests/create-workspace-runtime-meta-recovery.test.ts)
覆盖冷数据源、本地无云操作及查询期间销毁。竞态通过显式 deferred 信号控制，不使用睡眠。

四个针对性组件套件通过 90 项测试，CLI 命令套件通过 71 项。
仓库级类型检查、lint、格式化、脚本及 workspace 测试、i18n、导入守卫和平台/公开边界检查通过。
共享包、组件、CLI、Electron 完整套件分别通过 1,237、3,767、2,886、120 项测试；
CI 选择保留 CLI/RPC 套件原有的七项跳过。

验证使用 pnpm 10.20.0，在相同版本的隔离副本运行，安装锁文件依赖和固定的公开 ACP 子模块。
Node 26 需要 `NODE_OPTIONS=--no-experimental-webstorage`，避免原生 `localStorage`
干扰 jsdom。随后 `pnpm check` 运行到 Electron 时因缺少二进制停止；补齐匹配的
39.5.1 发行包后，Electron 及剩余检查阶段分别通过。没有为这些验证环境问题修改产品代码。
隔离副本的 `pnpm run docs check` 通过，保留 35 项既有警告，无 SHA 保护主题。
本嵌套工作树没有依赖且未初始化 ACP 子模块，其文档检查仍保留基线中的 28 个子模块断链。

未操作真实 Session、Issue 或 PR。Spec 保持 draft。
#574 和 #577 仍需正常的合并及关闭流程，本地实现不表示它们已经关闭。
