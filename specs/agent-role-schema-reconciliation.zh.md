# Agent Role Schema 自动收敛

Status: draft
Translation: current

[English](agent-role-schema-reconciliation.md)

升级后打开工作区时，应用会自动将当前用户保存的 Role 与其绑定的 Agent 进行对齐收敛，
无需进入设置页面、手动保存、确认弹窗、提示气泡或成功通知。工作区外壳在目录就绪后
启动该流程；离线目标机器在上线后再执行。

只有针对同一台机器和同一 Agent 配置、且匹配运行时覆盖项与客户端当前缓存格式的成功
运行时能力刷新，才可授权移除字段。静态默认值、缺失的 Schema、失败的探测以及更旧或
更新的缓存格式均不得触发破坏性收敛。该限制仅约束自动写回；常规缓存可读性仍遵循
[缓存兼容性规范](acp-capability-cache-compatibility.md)。

移除最新 Schema 不再声明的选项键；保留仍被声明字段的当前值（即使值已失效），以及
模型和权限固定项。显式权限、审批和沙箱选项保持可见以便人工修正。若已废弃的
`collaboration_mode` 取值为 `default` 或 `plan`，且新 Schema 声明了布尔型
`plan_mode`，则将其保留为 `false` 或 `true`；已有的 `plan_mode` 优先。当新字段与
可识别的旧协作选项均不存在时，已废弃的 `interaction_mode: plan` 同样迁移为 `true`。
维护过程不会固定新增的可选默认值。对于其余选项的移除，系统会将 Role 的目标模型
（`runConfig.modelId` 或通用 `configOptionValues.model`）与探测时的模型、该模型已记录的
`observedModelConfigOptions` 条目以及显式按模型控件声明（`declaredModelControls` /
`modelReasoningEfforts`）进行比对；若以上来源均无法确认目标模型的支持范围，可能与模型
相关的选项键将予以保留，直至其支持情况明确为止。

仅 Role 所有者可持久化收敛结果。延迟返回的结果不得重建已删除的 Role，也不得覆盖期间
发生的人工编辑。发生变更的 Role 仅递增一次 `revision`；无进一步变化时重复收敛不执行
写入。已接受的 Operation 与会话来源记录保持冻结不变。

写入在本地立即生效，并通过既有目录通道独立上传。探测或写入失败时保留原 Role；重新打开
工作区或网络重连后会自动重试失败的探测。不得使用全局“升级完成”标记跳过首次启动时不可用
的 Role 或机器。

证据：`packages/shared/src/agent-role.ts`、
`packages/components/src/hooks/use-agent-role-schema-reconciliation.ts`、
`packages/components/src/lib/agent-role-schema-reconciliation.ts` 及其测试。
