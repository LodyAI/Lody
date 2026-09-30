# 将 Prompt Shortcuts 从开发者 Beta 提升为正式功能

Status: implemented
Translation: current

[English](2026-09-29-prompt-shortcuts-general-availability.md)

## 摘要

Prompt Shortcuts 原先同时要求开发者模式和 Beta 开关，普通用户无法发现该功能。本次移除设置、快捷指令发现与 runtime 初始化的产品围栏，删除桌面和移动端「关于」中的开关及废弃文案。现有工作区与平台边界继续生效。旧开关值直接忽略，无需存储迁移。

## 决策与证据

本次替代[移动端 Beta 开关决策](../bug-fix/2026-09-25-mobile-prompt-shortcuts-beta.zh.md)中的主动启用要求。保留恒为 true 的 feature atom 只会留下无用间接层，因此调用方直接使用现有就绪条件。[Runtime 生命周期保护](../bug-fix/2026-09-25-prompt-shortcut-runtime-lifecycle.zh.md)仍有必要并保持不变。

产品意图见[可用性规格](../../../../specs/prompt-shortcuts-availability.zh.md)。开发者模式测试验证旧偏好关闭时设置入口仍然可见，并移除废弃 Beta 开关预期。Provider 测试保留就绪状态、工作区及平台替换覆盖。原生移动端交互未手动验证。

## 验证

Provider/设置的针对性测试共 10 项通过，修改文件 lint、文档检查与仓库脚本测试通过。提高 Node 堆内存后，Web 与移动端生产构建完成。完整云版本构建进入 Electron 打包时因缺少 `VITE_ELECTRON_UPDATE_URL` 部署配置而停止。原生移动端交互仍未手动验证。
