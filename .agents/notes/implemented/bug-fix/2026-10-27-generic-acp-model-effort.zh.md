# 从通用 ACP 模型配置选项派生思考强度

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1968
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

将 Devin gitlink 从 `d49d357` 更新到 `15c12e1`，即[适配器 PR #6](https://github.com/LodyAI/acp-extension-devin/pull/6)的合并提交。它增加能力声明，但不能单独修复主仓库的选择路径。官方运行时仍为 `3000.11.3`，无需更新下载产物及校验清单；适配器自己的协议 manifest 随 gitlink 一起更新。CLI 打包器现在内联所有 manifest 读取，包括新增的 protobuf 布局读取，保证重定位后的适配器不依赖相邻 manifest 文件。

## Pi 跟进：启动时的模型应用顺序

[Pi 适配器 #24](https://github.com/LodyAI/acp-extension-pi/pull/24)提供逐模型强度列表，但启动配置解析丢弃了主仓库传入的独立 `modelId`，导致 thinking 被应用到之前的模型，并拒绝对目标模型有效的强度。[适配器 #25](https://github.com/LodyAI/acp-extension-pi/pull/25)的提交 `989532ea55ee27a6d7a8455ae736c54022cb0dea` 优先选择 `modelId`，缺失时回退到字符串模型配置选项，然后应用 thinking。独立字段格式错误不会丢弃其余启动配置。Pi 的非推理模型声明的是 `["off"]`，而非空列表，因此仍显示 Off 选项。无需主仓库专用发送补丁或修改适配器源码。

Pi 是独立下载的运行包，与随 CLI 打包的 Devin 适配器不同。依照[运行时更新决策](../process/2026-09-17-managed-runtime-refresh.zh.md)，产物发布并回读校验后，gitlink 与 `pi-runtime-manifest.json` 必须同步更新。生产指针在分发步骤可用之前保持 `81c960da`。候选包使用精确提交成功 [CI 40500946908](https://github.com/LodyAI/acp-extension-pi/actions/runs/40500946908) 的两个 Windows 模块。本地 Pi 检查通过（111 项测试、1 项跳过），构建和真实 CLI 合成 smoke 也通过；这些检查不代表生产下载可用或已验证真实认证 Provider 会话。生成包通过包内依赖闭包 smoke，两次归档字节一致；使用候选 manifest 的主仓库 managed-runtime 和启动测试也通过（57 项）。候选包的标准下载 URL 返回 HTTP 404，因此集成阻塞于不可变产物发布。

候选版本：`0.2.0-lody.989532ea55ee`；文件：`lody-pi-0.2.0-lody.989532ea55ee-88928a6b2a8c81a6.tar.zst`，大小 16,188,064 字节。SHA-256：`88928a6b2a8c81a67d2902cce4c4695774cd351c74c707ec4481bbcf349b5956`。发布后必须完整回读标准下载 URL 并验证散列和大小，再同时更新 gitlink 与 manifest。本次未发布 release 或上传产物。

## 验证与限制

合成行为测试覆盖 custom/registry 的两个派生阶段、任意配置 ID、空强度、恢复、无效模型回退、完整 runtime 快照和发送过滤。原有内置模型测试保留在同一测试集中。打包契约测试在没有文件系统相邻文件的情况下导入经过转换的真实适配器 manifest 模块。这些测试不覆盖真实已认证的 Devin 会话或桌面交互；能力声明仍依赖适配器找到兼容的本地模型缓存。
