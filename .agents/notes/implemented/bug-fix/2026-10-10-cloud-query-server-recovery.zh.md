# 云查询服务端错误先有限重试，再进入渲染错误页

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1398

[English](2026-10-10-cloud-query-server-recovery.md)

## 摘要

认证查询适配层会恢复过期认证，但普通服务端失败仍直接抛进渲染。机器可见性
还被 Outlet 错误边界上方的运行时 provider 读取，偶发失败可能因此替换整个应用。
现在，同一客户端、session 和查询参数共享一次订阅及三次延迟重试，运行时也有
明确的外层边界。恢复期间返回加载状态，不使用过期授权数据；持续失败仍需手动
恢复，托管服务端为何失败尚无法确认。

## 决定与依据

Convex 会合并相同查询的订阅。只重试一个消费者，其他消费者仍订阅时，失败
查询继续存在。因此适配层统一持有按引用计数的订阅，退避期间释放它；新订阅
收到更新之前，不采用 SDK 缓存里的旧错误。定时器和回调随订阅失效，session
及查询身份隔离结果。只有连续健康 30 秒才补充次数，避免短暂成功造成循环。

只有非结构化的 Convex 查询 `Server Error` 才进入重试。结构化应用错误仍交给
正常错误处理，认证过期继续交给[中央恢复控制器](2026-10-10-bounded-auth-recovery.zh.md)。
拒绝保留旧的机器授权行，因为授权状态未知时不能视为当前有效。拒绝自动重置
React 边界，因为它会卸载运行时并移除诊断；耗尽之后仍遵循
[手动崩溃恢复](2026-09-16-renderer-crash-manual-recovery.zh.md)。可选功能仍需要
[局部边界](2026-09-14-share-request-cards-query-isolation.zh.md)。
根层认证失效副作用保留在运行时边界之外，因此运行时失败不会阻止已确认
session 失效后的清理。

[hook README](../../../../packages/components/src/hooks/README.md#cloud-query-recovery)
记录实现行为，不再为此单独维护 Spec。此次只覆盖
已认证的只读查询，公开查询及 mutation/action 错误处理保持原行为。没有诊断
或修改托管机器可见性查询的实现。

## 验证与限制

现有 hook 测试使用合成结果和假定时器，验证保持挂载、共享订阅、旧错误隔离、
耗尽、结构化错误、认证 skip、健康清零及清理。运行时兜底直接包在现有根组合中。
生产服务端失败及后台日志不在本次检出的证据范围内。

21 个查询 hook 用例及 100 个相关认证、可见性、手动边界、平台 provider 和
会话操作用例通过；共享 UI 类型检查、修改文件 lint 和平台边界检查也通过。
首次仓库文档检查被指向未初始化 Kimi/Grok 子模块的八个链接阻塞；公共边界检查
当时无法解析 Devin/Grok 工作区包。首次拉取后两个子模块时，获取 GitHub 凭据失败。
首次根 `pnpm check` 也在未修改的 Claude 适配器构建处停止，因为其
依赖尚未安装，包括 `@tsconfig/node22`。
未修改后端或执行部署。

CI 静态及单元测试检查通过。桌面 smoke 在场景步骤之前因 harness 首次导航
失败；独立的[harness 决定](../testing/2026-10-10-e2e-initial-renderer-navigation.zh.md)
记录修复和验证。随后本地子模块及依赖初始化成功，文档检查现已通过。
