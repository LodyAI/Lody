# 本地 GitHub PR 观测

Status: draft
Translation: current

[English](local-github-pr-observation.md)

带有 GitHub 远端的本地 Git 项目可以使用所属机器上的凭据显示对话的 PR 和 CI
摘要，无需 Lody 云端账户、GitHub App 安装或产品云端仓库登记。远端只标识仓库，
成功的 GitHub 查询才证明读取权限。没有 GitHub 远端的目录仍支持本地分支展示。

## 职责

创建时记录共享 Git 远端解析器识别出的仓库。激活或显式刷新已有本地工作目录时，
先观测运行时分支，再补齐缺失的仓库标识；不替换已记录的仓库，也不改变本地项目身份。

机器上的现有 PR 协调器统一负责发现、状态、CI 摘要、配额、重试和轮询频率。
可用时优先使用托管凭据，否则使用本地 `gh` 对 github.com 的认证。凭据留在机器上。
缺少凭据时可重试，凭据变更无需重启。无法查询 `/user` 不等于没有 PR 读取权限；
无法识别身份的凭据共享保守的配额桶。

只有存在托管关联端口时，发布前才必须完成托管关联。本地模式直接把成功观测写入
所属会话元数据。缺少认证、仓库不可访问或查询失败，不得虚构 PR 或删除既有成功观测。
登录和权限变更在后续满足冷却条件的轮询中生效。

桌面端对本地与托管项目读取相同的元数据。没有托管 GitHub 集成时，PR 链接在浏览器
打开 GitHub；本地摘要读取不会启用详细检查、审查和修改 API。分支观测由事件触发，
PR 发现与状态使用有界后台轮询，不为每个视图增加轮询循环。本地模式仍禁止产品云端请求。

## 证据

- [协调器边界](../apps/cli/src/lib/pr-poller/AGENTS.md)
- [工作目录 Git 观测](../apps/cli/src/session/workspace-git-service.ts)
- [决策](../.agents/notes/implemented/feature/2026-09-24-local-github-pr-observation.zh.md)
