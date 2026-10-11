# ACP 启动模型选择

Status: draft
Translation: current

[English](acp-startup-model.md)

## 场景

会话记录中的 Codex 模型与用户全局 Codex 配置不同时，驱动该轮的模型选择应在
原生会话建立前生效，避免恢复阶段先发出模型不一致提醒，再应用用户选择。

## 契约

宿主通过 Core 的 `_meta.lody.sessionConfig` version 1，把驱动轮的 `modelId`
和配置选项传入新建、加载、恢复和分叉。成功的实时模型选择成为后续替换进程的
启动选择。预热会话的兼容性检查也必须包含启动模型。

Codex 在建立原生会话前转换显式 `modelId`；缺省时使用 `model` 配置选项。
旧式 `model[effort]` 保留推理强度，但显式 `reasoning_effort` 选项优先。
省略启动选择时保留原生默认行为；传入非法选择时，在原生线程建立前失败。
主动选择与记录不同的模型时，原生 warning 仍正常显示。

该元数据为增量扩展，旧 adapter 可能忽略；宿主原有的实时配置应用仍需保留。
宿主和 Codex adapter 改动须配套发布，才能提供启动阶段的保证。

## 证据

[决策记录](../.agents/notes/implemented/bug-fix/2026-10-09-codex-resume-model.zh.md)
说明实现、验证和限制。
