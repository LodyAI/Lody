# 在工作区启动时收敛过时的 Role 选项

Status: implemented
Translation: current

[English](2026-09-11-agent-role-schema-reconciliation.md)

## 摘要

Plan schema 的变更在已保存的 Agent Role 中遗留了过时的选项 key，即便新控件已经出现仍会持续产生
告警。工作区启动现在会静默探测已绑定的 agent，并为 Role 所有者持久地移除已退役的选项 key。已知的
旧版协作选项会迁移为布尔 Plan，而权限固定与既有选项的非法取值保持不变。能力发现缺失或失败时会推迟
该工作，而不是把「缺失」当作「不兼容」。

## 决策

工作区窗口的所有者在 Settings 之外挂载该维护逻辑，时机是在工作区与目录就绪之后。它复用 Machine
Flock 订阅与运行时的 Machine RPC，串行化探测并在同一目标的多个 Role 之间共享结果。每次启动都可以
重试；持久化本身是幂等的。不存在可能让离线 Role 被永久搁置的全局完成标志位，也没有 UI 通知。

此前「仅在编辑器中处理」的提案仍要求打开并保存 Role。而无条件地按静态选择器过滤，可能仅因为发现
不完整就抹掉选项。字段是否存在由新鲜的原始 config 选项定义；选择器投影与依赖模型的取值列表不足以
授权删除。移除未知选项还要求固定模型相匹配；已知的过时独立 Plan key 则可在新的布尔契约存在时收敛。

`WorkspaceWriter.flockRowUpdate` 在一次本地 Flock 事务中读取并有条件地替换一行。收敛逻辑在获取
文档之后检查归属、修订、内容与活跃 effect。这为期间发生的本地编辑/删除与工作区切换设置了围栏；
它不引入分布式 compare-and-swap，也不改变 Flock 既有的离线并发行冲突语义。上传在持久变更之后仍是
尽力而为。历史的 Session/Operation 配置不受影响。

本记录扩展了[Plan 消费者修复](2026-09-10-core-plan-mode-consumers.md)，后者刻意没有重写已存储状态。
当前意图见[收敛 Spec](../../../../specs/agent-role-schema-reconciliation.md)。

## 验证

行为测试覆盖启动就绪、探测失败/不匹配/不完整、旧版 Plan 迁移、模型/权限/取值固定的保留、幂等性，
以及带延迟获取、编辑、删除、取消与写入失败的真实 Flock 写入。Role 表单、启动 hook、工作区 writer、
目录房间与目录写入五个套件的全部 63 个测试通过，其中包括探测进行中登出/销毁，以及拒绝不匹配的
config/provider/agent、未来缓存版本与临时能力。未使用运行中的桌面端或真实用户目录。

### CI 修复与消融

运行 `34554474320` 的完整 Static checks job 日志显示格式化与所有限定范围的类型检查通过，随后
类型感知 lint 因 `consistent-return` 失败。就绪分支隐式返回，而活跃 effect 返回了 cleanup。显式
`return undefined` 在不移除取消能力的前提下修正了返回契约。最初的普通限定范围 lint 漏掉了这条
类型感知规则。初次本地验证的依赖限制通过固定 submodule 与独立的 frozen-lockfile 安装解决；该
checkout 的安装守卫允许这种布局。

逐步消融使用上述五个套件（63 个测试）；反向对照使用启动套件（12 个测试）。仅凭测试通过不构成
等价性证据。

| 实验 | 证据 / 结果 | 决策 |
| --- | --- | --- |
| 显式 undefined 基线 | 63 通过；限定范围的类型感知 lint 无错误 | 保留 CI 修复 |
| 移除调用方侧的机器 ID 去重 | 订阅所有者已通过 `Set` 归一化；63 通过 | 保留删除 |
| 从探测 key 中移除单独的机器 ID | 精确目标的 config 查找保证序列化后的 config 已包含该 ID；63 通过 | 保留删除 |
| 移除 effect cleanup | 2 失败 / 10 通过：登出与工作区销毁会错误地改写已存储的 Role | 恢复保护 |

被保留的简化不改变迁移意图，也不削弱身份、schema 新鲜度、归属、模型兼容性或事务写入守卫。恢复
cleanup 之后，全部 63 个定向测试再次通过。完整的 `pnpm check`、`pnpm check:quick`、
`pnpm format:check`、限定范围的测试格式化、`pnpm run docs check` 与 `git diff --check` 均通过。
`pnpm format` 完成；其中与本次无关的 Electron 测试格式化已排除。完整检查包含 3,423 个组件测试与
全部工作区类型检查；既有的跳过测试与 lint/文档体积告警仍然存在。

PR: [#588](https://github.com/LodyAI/Lody/pull/588)。
