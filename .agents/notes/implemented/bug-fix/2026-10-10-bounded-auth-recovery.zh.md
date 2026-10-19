# 停止耗尽后的认证恢复

Status: implemented
Translation: current

[English](2026-10-10-bounded-auth-recovery.md)

## 摘要

认证恢复原先只限制间隔、不限制次数，session 与 Convex 身份不一致时会无限加载。
现在由恢复控制器限制六次尝试，每次最多等待 15 秒；耗尽后持续显示错误对话框，
提供主动重试和重新登录入口。页面状态保留，网络故障不会被当成 session 撤销。
连续健康一段时间才清零次数，短暂成功不能绕过上限。

## 决策与依据

Provider 负责调度、超时退役和 session 隔离。加载、离线和前后台切换都不增加预算。
超时的 session 请求可能仍在底层 SDK 中完成，但其晚返回不能通过本控制器重新启动
Convex 认证。期限也覆盖 Convex 没有发出加载状态变化的情况。
新 session 先退役旧请求，再使用新预算。

没有采用立即退出，因为认证状态不一致不能证明底层 session 已无效；没有保留
无限退避，因为它缺少稳定错误状态和用户恢复入口。对话框保留路由挂载状态，
重新登录复用现有退出动作。[行为约定](../../../../specs/auth-recovery.zh.md)仍为草案。
此修复补充了[遥测过滤](2026-10-09-posthog-auth-error-filter.zh.md)，后者不控制恢复流程。

虚拟时钟测试覆盖拒绝、挂起请求、缺失的认证重置状态、晚返回、session 更换、
离线切换、短暂认证成功、耗尽和主动重试。相关查询、session 与 token provider 测试通过。
确定性测试不代表真实凭据到期的端到端验证，本次也不部署。

## 消融依据

[PR #1382](https://github.com/LodyAI/Lody/pull/1382) 中，移除缓存的 pending Promise
和第二处进行中检查后，36 项认证/session/query 测试仍通过。调度 effect 是唯一
调用方，已经检查进行中的尝试，因此删除这份重复状态。反向对照中，移除最后一个
非空 session 的保留逻辑，会使临时 session 消失时的预算测试失败；移除 generation
隔离，会使 session 更换测试失败。这两项保护保留。各变体均从恢复后的基线独立测试。
