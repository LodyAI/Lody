# DimCode 移动端权限选择器 ID 冲突

Status: implemented
Translation: current

[English](2026-10-09-dimcode-mobile-permission-picker.md)

## 摘要

DimCode 新建对话时，两个移动端选择器共用协调器 ID，可能导致权限选择在发送前就丢失。按下选项会同时关闭两个列表；如果松手前选项已卸载，选择回调便不会执行。使用 DimCode 实际上报结构的合成数据，在 Chromium 触摸输入中复现了这一问题；临时隔离通用选择器 ID 后，提前关闭消失。修复已为 provider 通用选择器使用独立 ID 命名空间，保留全部已有模式和配置回调；尚待原生打包设备验证。

## 证据

检查的源码版本为 `26336e4a2`。Lody Agent 目录中的 DimCode 同时上报 `agent` / `goal` 模式，以及 ID 和分类均为 `permission` 的选择配置，其值包括 `read-only`、`workspace-write`、`full-access`。

- `packages/components/src/lib/acp-selector-order.ts` 只把 ID 为 `permission_mode` 或分类为 `_permission` 的项识别为显式权限。DimCode 的权限进入 `otherSelectors`。
- `mobile-run-config-sheet.tsx` 给这个通用配置项生成 `run-config-${selector.configId}`，得到 `run-config-permission`。旧模式行也使用相同 ID，虽然内容是 Agent/Goal，却同样标为 Permission。
- `mobile-inline-picker.tsx` 按共享的 `activeId` 展开列表，因此两个列表同时打开。文档级捕获阶段的 `pointerdown` 监听器把另一个选择器内部的按下当作外部点击，清空 `activeId`。选择回调要等到 click；0.2 秒退出动画可能先卸载目标。

隔离 UI 挂载真实的 `MobileNewChatSheet`、`MobileSessionRunConfig` 和组件本地配置选择 hook，数据为符合上述结构的合成配置。在 393 × 852 的 Chromium 触摸视口中，先等待目标稳定可操作，再按下 Full Access。事件目标确认是该选项，但列表提前关闭并卸载；随后松手，`permission` 仍为 `workspace-write`。仅临时将通用选择器 ID 改为 `run-config-option:${selector.configId}` 后，只展开预期列表，按下仍保持展开，松手成功选中 `full-access`。ID 隔离现已保留在产品代码中；临时浏览器测试入口已移除。

Chromium 和 WebKit 的快速自动化 tap 均成功。因此证据确认的是提前关闭和丢失选择的路径，并不证明每次点击必败，也不证明报告设备运行相同版本。依赖复用了其他本地 checkout；未做干净安装、原生打包设备验收、完整类型检查或构建。

## 修复与内置 Agent 检查

Provider 通用配置项改用 `run-config-option:${selector.configId}`，内置行保留各自 ID。不改变权限策略、载荷、选择生命周期或 Spec 意图。新建对话和已有会话共用控件，因此同时获得修复。

目录检查确认 DimCode 存在冲突。已上报的 Claude、Codex、DeepSeek Harness 和 Devin 使用旧 `mode` 路径；Kimi、Grok 使用 `permission_mode` / `_permission`。旧版 Kimi 的模式选择器、Grok 的交互选择器也不触发该冲突。Pi 未上报权限控件。Bub 本次既没有可用运行时上报，也没有静态权限结构；它使用用户自行安装的 ACP 服务，仍需运行时验证。命名空间修复对任意 provider 配置 ID 生效，不依赖 Agent 名称。

原 `mobile-run-config-role-row.test.tsx` 更名为 `mobile-run-config-sheet.test.tsx`，扩展真实新建对话组件和本地选择 hook 的测试。覆盖七种内置权限结构（Claude/Codex/Kimi/Grok/DeepSeek 静态配置，DimCode/Devin 合成运行时配置）、Pi 无权限控件，以及 permission/agent/role/model/interaction/reasoning 六类合成保留 ID 冲突。验证按下时列表仍展开、松手后状态与标签更新、重新打开保留选择；DimCode 独立的 Agent 模式保持不变。修复前七个用例失败；修复后控件、配置选择、选项构建和桌面权限四套测试共 100 项通过。Role 仅检查回调的用例替换为可观察的选中／清空行为。

本次暂不全局识别 `permission` 分类：直接把它加入显式权限分组会隐藏 DimCode 独立的 Agent/Goal 入口。因此保留既有分类及展示；旧模式行标签不准确是尚未解决的独立展示问题。参见[运行配置归属](../../../docs/sessions-run-config.md)。

此前发现的已有会话就绪门槛不一致是独立问题：界面控件可用时，作用域草稿可能尚无编辑租约。新建对话使用没有该门槛的本地选择，因此不要把本次报告归因于[草稿保留改动](../../implemented/bug-fix/2026-10-07-session-run-config-drafts.md)。

验证边界：改动文件的 Oxfmt 和 Oxlint 通过。组件类型检查被当前 checkout 缺失的依赖（包括 Electron）和未解析的工作区导入阻断，未宣称完整构建或检查通过。`docs check` 仍为基线的 70 项错误、65 项警告，改动文件无错误。

准备 PR 时也尝试了根目录 `pnpm check` 和 `pnpm format`，均因该嵌套 checkout 未安装工作区工具链（`tsgo` / `oxfmt`）而停止。上述定向验证使用了已有安装的临时依赖链接。
