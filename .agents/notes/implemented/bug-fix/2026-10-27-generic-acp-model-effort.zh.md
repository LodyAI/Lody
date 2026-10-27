# 从通用 ACP 模型配置选项派生思考强度

Status: implemented
Translation: current
Language: [English](2026-10-27-generic-acp-model-effort.md)

## 摘要

Registry 和 custom Agent 通过带有模型分类的配置选项选择模型，但思考强度派生仍使用独立模型字段或探测时的默认模型。因此即使适配器已声明各模型能力，输入框仍显示错误的强度列表。现在两个派生阶段都读取真实的模型配置 ID，最终解析先验证模型值，再派生强度。配置选项的发送格式和完整 runtime 快照语义保持不变。

## 决策与证据

本修复纠正了[逐模型能力决策](../architecture/2026-09-29-per-model-acp-capability-row.zh.md)中的通用 Agent UI 路径，对应 [#1957](https://github.com/LodyAI/Lody/issues/1957)。

- 候选选择器通过 `category: model` 选项的真实 ID 读取 `configOptionValues`，不假定 ID 是 `model`。内置 Agent 的模型选择保持不变。
- 最终选择复用原有配置表解析规则：有效用户编辑优先；存在 runtime 表时，它拥有全部非用户键集合，包括被省略的键；仅无 runtime 表时使用偏好及选择器默认值。省略的模型键可以用探测默认值决定显示，但不会被插入发送表。
- 通用 Agent 保留尚未按模型过滤的探测选择器。不支持强度的候选模型可能隐藏控件，但权威验证可以回退到支持强度的模型；复用已过滤的选择器会永久丢失控件。空强度声明隐藏控件，并从权威发送表中移除该选项。
- 改为填充独立模型选项会改变通用 Agent 的发送表示，因此保留基于分类的配置值。探测时没有强度控件的情况下，不猜测或合成任意强度 ID。

## Devin 集成

只将 Devin gitlink 从 `d49d357` 更新到 `15c12e1`，即[适配器 PR #6](https://github.com/LodyAI/acp-extension-devin/pull/6)的合并提交。它增加能力声明，但不能单独修复主仓库的选择路径。官方运行时仍为 `3000.11.3`，无需更新下载产物及校验清单；适配器自己的协议 manifest 随 gitlink 一起更新。CLI 打包器现在内联所有 manifest 读取，包括新增的 protobuf 布局读取，保证重定位后的适配器不依赖相邻 manifest 文件。

## 验证与限制

合成行为测试覆盖 custom/registry 的两个派生阶段、任意配置 ID、空强度、恢复、无效模型回退、完整 runtime 快照和发送过滤。原有内置模型测试保留在同一测试集中。打包契约测试在没有文件系统相邻文件的情况下导入经过转换的真实适配器 manifest 模块。这些测试不覆盖真实已认证的 Devin 会话或桌面交互；能力声明仍依赖适配器找到兼容的本地模型缓存。
