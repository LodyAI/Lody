# 无托管仓库关联时读取公开 PR

Status: implemented
Translation: current

[English](2026-10-11-public-pr-details.md)

## 摘要

已记录的 PR 可能可见，但工作区未关联仓库导致详情加载失败。公开仓库现在通过匿名路径
读取 PR 详情、审查及变更。修改仍要求托管仓库身份，私有或身份不匹配的仓库仍被阻止。
匿名额度及网络错误仍可能导致加载失败；尚未验证线上移动端部署。

## 决策与证据

共享身份 Hook 在托管身份未确认时匿名查询 GitHub 元数据，要求明确的公开标记、匹配的
仓库名称、正整数 ID，以及与已有 ID 一致，并拒绝重定向。所得 ID 仅用于公开读取，
不代表托管关联或写权限。REST 辅助函数在公开读取的空令牌场景省略 Authorization，
包括文件内容请求。PR 容器不提供修改回调，操作分发也拒绝写入。
公开读取不复用认证缓存。公开 CI 刷新降为五分钟，并跳过快速合并状态轮询，节省匿名额度。

本变更扩展了[观测与关联分离](../../proposed/bug-fix/2026-10-01-pr-observation-association.zh.md)：
缺少托管关联不再意味着公开详情不可读。全局移除身份门控会允许仅凭名称执行凭据写入，
因此公开路径保持匿名。沿用现有 React Hook 生命周期，不更改 Effect 运行时或后端协议。
意图见 [PR 观测](../../../../specs/local-github-pr-observation.zh.md)。GitHub 文档说明了
[公开检查的匿名读取](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
与更低的[匿名请求额度](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)。

## 验证

合成测试覆盖无需令牌加载公开 PR、阻止修改、拒绝私有或身份不匹配的元数据、
切换页面后的迟到响应，以及省略认证头。七个相关测试套件共 92 项通过。
工作区类型检查、lint、i18n 及公开/平台边界检查通过。`pnpm check` 停在未改动的
CLI 递归 SSH 克隆用例（`context_unreadable`；CLI 4036 项通过），最终 PR 容器套件
单独运行通过。文档检查有六条指向未初始化 Kimi/Pi 子模块的既有断链，本次文档无错误，
没有受 SHA 保护的主题。尚未完成移动端运行验收。
未修改生产数据、仓库权限或已部署客户端。
