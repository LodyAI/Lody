# 直接选择目录与项目独立展示

Status: implemented
Translation: current

[English](2026-10-26-project-direct-folder-selection.md)

## 摘要

创建多文件夹 Project 不再要求先逐个添加独立项目。编辑器选择目录时只探测，保存时登记或复用目录，并将独立展示与成员关系分开。以后单独添加相同目录会恢复已有入口；移除入口保留源目录、成员关系和对话。目录登记与项目保存仍是独立写入，失败后保留可复用登记，不回滚可能被其他地方使用的状态。

## 决策与边界

用户要求实现[多仓库 Spec](../../../../specs/multi-repo-projects.zh.md#直接选择目录与独立展示)中的直接选择方案。本次完成初始研究中的创建与展示决策，不代表批准该草案的其他部分或之前的[多仓库提案](../../proposed/architecture/2026-10-16-multi-repo-projects.zh.md)。

- 复用目录浏览器，逐个添加文件夹到同一草稿。直接入口指向当前用户拥有的本机；保留已有来源选择，包括没有本机的平台。
- `projectFolderSelection` v1 能力控制可选的 `prepare-add` 探测。普通请求保持原响应形状。复用 daemon 的只读成员探测获取 Git 身份和子模块，不从父目录推断 Git 能力。
- 草稿路径与探测结果不写入 Project 定义。保存时重新校验规范化身份、Git 和仓库身份，登记所有所选目录，再写入完整项目。不回滚删除可能已被其他 Project 或会话使用的登记。关闭选择器会使迟到响应失效，保存入口防止重复提交。
- `LocalProjectMeta.standaloneVisible` 缺省为 true。展示列表过滤 false；可访问的登记、仓库副本查找和会话共享保留它们。隐藏不是权限控制。本地事务保留历史和其他字段，daemon 刷新保留当前展示状态；分布式并发写入沿用现有 Flock 收敛语义。
- 用户通过 UI/CLI 主动 Add 时复用身份并开启展示。UI 移除只关闭独立展示，不归档对话、不清理 worktree。旧的待执行移除命令及结果通知保持原语义；本次不新增 CLI/MCP 移除接口，也不自动回收登记。
- GitHub 来源保留仓库可迁移语义；普通目录绑定机器，并明确提示修改原文件。复用已有独立条目作为成员不会隐藏它。

只保留旧选择器会保留多余的前置步骤；把绝对路径直接存入成员会替换机器解析和可迁移契约。本方案调整展示并保留这些契约。旧版 UI 仍可能显示所有登记，因此此标记不属于安全边界。远端已登记但本地副本尚无该行时，报告不可用，不覆盖尚未观察到的历史。

## 实现与验证

主要文件为 `local-project-import.ts`、`project-group-form.ts`、`project-group-editor-dialog.tsx`、`visible-local-project-index.ts` 和 `apps/cli/src/lib/local-project-meta.ts`。renderer 保存 daemon 探测出的 GitHub 身份，使新登记副本立即可用于仓库 Project。复用现有 Promise 入口与原生探测适配层，没有引入生命周期迁移或新的进程所有者。

行为测试覆盖不写入的选择准备、复用与恢复展示、历史保留、畸形数据、目录和仓库变化、部分保存失败后的重试、隐藏副本可用性与 daemon 刷新。Playwright 使用合成文件系统操作真实表单与选择器，验证重复选择、取消和原地修改提示。截图来自同一 Storybook 流程，不代表已完成 Agent 会话或系统原生文件选择器的端到端验证。组件与 shared 全套测试、相关 CLI 测试、类型检查、lint、边界检查及文档检查通过。全量 `pnpm check` 尚未全绿：未改动的递归 SSH 传输测试报 `context_unreadable`，单独运行也能复现；测试流程提前退出，后续包的全套测试未验证。本次不修改 Git 凭据处理。
