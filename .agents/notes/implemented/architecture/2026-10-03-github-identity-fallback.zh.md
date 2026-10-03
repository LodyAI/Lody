# 用有序凭据降级替代实时 GitHub 身份策略门禁

Status: implemented
Translation: current

[English](2026-10-03-github-identity-fallback.md)

## 摘要

实时身份策略门禁使原生 Git 与 gh 在 Lody 凭据服务不可用时一同阻塞。
托管会话现在使用可信本地 owner 快照，按个人、具备资格的机器、仓库 App 顺序各尝试一次。
获取失败直接降级并记录安全、可归因的原因，不再查询独立策略或循环恢复 broker。
Git 在传输前执行原生只读访问通告；gh 不重放复合写入或结果不确定的操作。
生产 GitHub 和 Windows 端到端行为尚未验证。

## 决策与取舍

[契约草案](../../../../specs/github-identity-fallback.zh.md)替代
[旧策略恢复](../bug-fix/2026-10-01-github-policy-recovery.zh.md)中的策略故障禁止降级决定。
低优先级凭据可能具有更宽权限，这是本次要求的可用性策略，不代表原身份服务故障已修复。
机器资格仍来自可信对话 owner 与机器 owner 匹配；故障不能授予资格。
网络身份属于对话 owner；turn 的 commit 作者归属不变。

永久绕过 Lody 会失去个人/App 优先级，增加重试仍保留云门禁。
共享迭代器将可选 token 获取与原生执行分开；成功 token 按 owner、机器、仓库、来源
缓存至多 60 秒，失败不缓存。断线期间的撤销和配置传播仍是最终一致。

Git 使用 GIT_EXEC_PATH 下的原生 HTTP helper 适配器、标准 URL 和原生递归子模块。
适配器目录同时暴露 Git 自带支持文件，使 shell 子命令继续工作；SSH 规范化保留机器
候选的显式 443 端口。实现对最初“不预检”草案作了细化：使用原生 upload/receive-pack
通告，在 push 产生效果前拒绝候选；不保留 REST 权限模型或自定义 remote 协议。

gh 保留已有目标和参数解析器，避免凭据路由到错误仓库；直接执行原生命令。
只有无输出读取或明确拒绝的单次 REST 请求可降级。复合写入即使报认证错误也保留
原生结果，因为更早的内部请求可能已成功。

broker 暴露安全错误码与关联编号，不吞掉原因。token 服务启动失败不影响宿主本地
快照使用；并发启动共享一次尝试，不再有健康定时器或恢复循环。
这不修复独立的 MCP 可用性或完成钩子契约问题。

## 验证与限制

所属测试覆盖候选顺序、云故障时本机成功、非 owner 隔离、来源/owner 缓存分区和过期、
针对本地合成仓库的真实递归 SSH clone、不修改 refs 的 receive-pack 通告、checkout
凭据、参与者切换时 owner 稳定、gh REST 降级以及复合/部分写入不重放。
最终 CLI 测试有 302 个文件、3425 个用例通过（4 个跳过）；CLI 打包、全仓类型检查、
lint、平台和公开边界检查通过。测试进程使用 NODE_ENV=test 和 GIT_CONFIG_COUNT=0
隔离继承的会话路由。文档检查仍有 6 条指向未初始化 Kimi/Pi 子模块的既有链接错误。
不执行生产部署。

合成测试不能证明托管后端行为。公开客户端仍调用现有分来源 token RPC；服务端
策略和刷新实现不在本仓库。已运行 agent 需要刷新宿主环境和上下文文件；显式存储的
旧自定义 remote 需要迁移为标准 URL。Windows 与真实 GitHub 验证仍待完成。
