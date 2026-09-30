# Prompt Shortcuts 正式功能入口

Status: draft
Translation: current

[English](prompt-shortcuts-availability.md)

用户打开工作区设置后，无需开启开发者模式或 Beta 开关即可使用 Prompt Shortcuts。输入框在工作区 runtime 与 scope 就绪时可发现快捷指令，包括命令菜单中的入口。

旧的本地 Beta 偏好不再影响功能可用性。桌面端和移动端「关于」页面不再提供该开关。工作区身份、就绪状态、平台能力、快捷指令可见性和 scope 规则继续生效；正式开放不会授予读取他人快捷指令的权限。

## 实现证据

- 设置：`packages/components/src/components/settings/settings-tabs.tsx` 与 `prompt-shortcuts-setting.tsx`。
- 发现：`packages/components/src/components/mentions/use-shortcut-mention-source.ts`。
- Runtime：`packages/components/src/providers/prompt-shortcut-provider.tsx`。
