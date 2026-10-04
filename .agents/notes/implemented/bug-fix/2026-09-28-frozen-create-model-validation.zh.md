# 在冻结的会话创建配置中保留目标模型校验结果

Status: implemented
Translation: current

[English](2026-09-28-frozen-create-model-validation.md)

## 摘要

四次已接受的会话创建在到达目标机器前反复失败，因为恢复阶段拿错误模型的能力快照检查冻结的 `reasoning_effort`。冻结配置现在保留按目标模型验证的选项 ID；确定性的选择错误直接结束该项，不再重试。传输结果不确定时仍按原有界限重试。真实跨机器场景尚未验证。

## 决定与证据

[Issue #956](https://github.com/LodyAI/Lody/issues/956#issuecomment-5861823758) 中提供的源端原始日志显示，目标物化有 56 次 `Unknown ACP config option` 失败。源端探测的 `gpt-6-sol` 没有 effort 选项，而请求的 `gpt-5.6-sol` 支持 `medium`。接受阶段按请求模型验证，冻结配置却丢失 `validatedConfigIds`，恢复阶段因此拒绝本来有效的选项。[前一份诊断记录](2026-09-27-session-create-materialization-failure.zh.md) 只能保留错误，写作时尚无原始日志。

每个目标的有效调度配置都持久化已验证 ID，包括批量创建。恢复阶段只对这些 ID 跳过探测模型快照校验，保留已接受的具体配置，也不重新读取请求方默认值或 Role 目录。带类型的选项校验错误以 `COMMAND_REJECTED` 终止；目标写入和同步的不确定错误继续重试。

## 验证与限制

Session 配置、Operation 存储和 coordinator 测试覆盖模型不匹配、元数据持久化与终态失败。测试尚未证明真实 macOS 跨机器创建成功。
