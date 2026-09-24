# 使用本地凭据观测 PR

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/958

[English](2026-09-24-local-github-pr-observation.md)

## 摘要

本地会话能够显示分支，但 PR 发现仍受产品云端仓库登记和托管关联端口限制。
现在由 Git 提供仓库标识，由认证后的 GitHub 查询判断读取权限。现有机器协调器
在本地模式使用 gh 凭据运行，不要求云端关联。它提供 PR/CI 摘要且不向渲染端暴露凭据；
详细审查与修改仍属于托管能力。

## 决策与限制

复用 fleet 协调器，不添加渲染端轮询，也不虚构本地 CloudPort。托管工作区仍必须
完成关联，以支持 webhook 投递；本地明确没有此端口。一分钟凭据缓存允许在缺失、
登录和轮换后恢复。GitHub 安装凭据可能查询 PR 成功而 `/user` 失败，此时使用共享
保守配额域，不把用户资料权限当作仓库授权。

新建本地会话保留远端解析的仓库，无需查询云端登记。原分支服务改名为
WorkspaceGitService，在授权后的根目录激活或刷新时补齐缺失标识；保留已配置身份，
串行观测，先发布分支再让缺失的仓库进入发现流程。普通文件刷新不增加 Git 探测。
已有会话打开或刷新后进入发现流程，不增加全局扫描。

本地 PR 链接在外部浏览器打开，因为摘要读取不启用云端令牌详情 Hook。
认证和仓库冷却策略仍生效，登录不保证立即刷新。没有远端时无法发现 PR。

## 验证

CLI 定向测试覆盖无关联的本地发现、托管关联失败、Git 工作目录补齐、登录/轮换/退出、
凭据配额和 Git 刷新触发。只读实测确认一个不能请求 `/user` 的本地凭据仍能读取 PR。
`pnpm check`、`pnpm format` 和 `pnpm run docs check` 通过；未进行原生桌面点击验证。

约定：[Spec](../../../../specs/local-github-pr-observation.zh.md)。
分支行为：[前序决策](../bug-fix/2026-09-24-workspace-branch-observation.zh.md)。
