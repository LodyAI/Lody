# 要求 Agent 命名前先由守护进程确认临时分支

Status: implemented
Translation: current

[English](2026-10-09-daemon-branch-naming-eligibility.md)

## 摘要

首次任务提示词原先要求 Agent 检查分支是否为临时分配，导致 Agent 为守护进程
本可判断的事实多调用一次工具。执行层现在在 setup 后检查实际检出，仅对本
会话分配的引用直接要求命名。未知或描述性分支跳过要求；新名称及 Git 操作仍
归 Agent 负责。尚未通过真实模型调用测量工具调用节省。

## 决策

这细化了[原先的命名指导](../feature/2026-10-08-new-worktree-branch-prompt.zh.md)。
首次使用资格保持不变，包括预创建 Worktree 的采用，并排除直接目录、子标签页、
已有／恢复会话、后续回合和 Fork。仅符合条件的启动，在 `createSession` 完成后
读取 `git branch --show-current`。创建和识别共享分配规则，包含名称及命名空间
的数字碰撞后缀。匹配当前会话 ID，而不是宽泛的 `lody/` 前缀。Detached HEAD、
其他会话引用及读取失败均跳过要求，不阻止任务；展示元数据不参与这一判断。

提示词在 `git branch -m <old> <name>` 中明确指定已确认的旧引用，防止后续检出
使命令改到其他分支。保留简短的描述性命名、避免敏感输入、碰撞处理及改名失败
时说明并继续任务的要求。符合条件的启动新增一次守护进程 Git 读取，并移除
Agent 检查要求；不强制模型遵循。冻结的 Config／Role 文本和附件仍通过共享
执行输入解析器组合。[分支约定](../../../../specs/workspace-branch-state.zh.md) 仍为 draft。

## 验证与限制

Provider 边界测试覆盖两种命名空间、名称／命名空间碰撞、描述性分支、其他会话
引用、Detached HEAD 和读取失败，并分别测试 Provider 是否自有标题生成能力。
仍覆盖附件、冻结指令与后续回合排除。分配测试将识别规则与真实碰撞分配器对照。

验证：执行服务、提示词、Git 观测与分配套件共 217 项通过。根 `pnpm check`
通过工作区类型检查和 lint，随后在已有的原生递归 SSH 子模块用例
（`github-git-transport.test.ts`）处停止，Lody Git 包装器返回 `context_unreadable`；
CLI 共 3574 项通过、1 项失败、4 项跳过，完整流水线未完成。
根格式化、范围内格式、文档、i18n 及仓库边界检查通过；未调用真实 Claude／Codex 或进行桌面界面冒烟测试。
