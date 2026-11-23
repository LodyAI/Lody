# 保持 Provider 配置弹窗能力实时更新

Status: implemented
Translation: current

[English](2026-09-16-provider-dialog-live-capabilities.md)

## 摘要

测试 ACP Provider 后，持久化能力已经刷新，但设置弹窗仍读取打开时保存的 Machine
快照，导致标题生成选项只能在重新打开后出现。弹窗空闲时还错误地显示正在检测。
设置页现在只保存目标机器 ID，每次渲染都读取当前可见的机器数据。标题区域在空闲时
提示点击测试，仅在实际请求期间显示检测中的文案。

## 决策与证据

`refreshCapabilities` 已经负责重新同步 Machine Flock 数据，在弹窗内再保存一份能力
缓存会重复数据权威。因此，`MachineAgentSettings` 按打开弹窗的机器 ID 传递实时数据，
不受当前手风琴选中项影响。机器不再可见时，弹窗不能使用旧快照继续渲染或提交。
元数据更新时弹窗 mode 保持稳定，从而保留正在编辑的表单。

本次修复仅调整 UI 对数据的读取，不改变
[缓存兼容性契约](../../../../specs/acp-capability-cache-compatibility.md)或
[ACP 标题所有权](../architecture/2026-09-08-acp-owned-session-titles.zh.md)。
现有弹窗测试集覆盖空闲与请求中的提示、失败恢复，以及 Machine 属性更新后无需重开
即可显示并保存标题选项。组件检查不覆盖真实 ACP 进程或桌面会话。
