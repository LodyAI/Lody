# Preferences 开关的可访问名称

Status: implemented
Translation: current

[English](2026-10-01-preferences-switch-names.md)

## 摘要

Preferences 的四个开关有可见标签，却没有可访问名称，读屏可以读出状态但无法识别对应偏好。
开关现在引用现有翻译标签，并在说明存在时关联说明。这补全了语义，未改变通知授权、
归档默认值或偏好存储。Chromium 回归使用隔离偏好和合成通知服务；原生读屏朗读和
生产通知投递仍未验证。

## 证据与决策

main `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04` 的四个开关在 Chromium 可访问性树中
没有名称。中英文浏览器用例均无法按可见名称定位代码行变更开关。相关 PR 搜索未发现
已有有效修复。

`CompactRow` 将标签作为控件旁的段落渲染。Switch 的 ID 本身不建立标签关联，归档
开关也没有任何关联。这是
[既有设置行语法](../feature/2026-09-26-settings-row-grammar.zh.md)的语义缺陷，
没有改变产品意图。

`CompactRow` 提供可选文本节点 ID；四个调用方使用 `aria-labelledby`，代码行变更和
通知说明使用 `aria-describedby`。React `useId` 将引用限定在各挂载实例；通知没有
说明时移除说明引用。显式关联避免复制第二份翻译标签，也避免自动给多控件行中的
所有控件命名。键盘行为和 `aria-checked` 仍由 `@lody/ui` Switch 负责。

```mermaid
flowchart LR
  L[翻译后的行标签] -->|aria-labelledby| S[Switch：名称和选中状态]
  H[当前渲染的说明] -->|aria-describedby| S
```

## 验证与边界

[浏览器测试](../../../../packages/components/tests/e2e/preferences-accessibility.spec.ts)
通过隔离的
[Storybook 场景](../../../../packages/components/src/stories/GeneralSettings.stories.tsx)
挂载真实 Preferences 组件，检查中英文名称、说明、保持关闭的默认值、Tab 顺序、
Space/Enter 状态切换及通知加载后重新挂载的路径。测试阻断外部 HTTPS 请求；通知可用
用例仅将通知服务模块替换为返回合成异步授权结果的实现。

Node 26.10.0 下四项浏览器用例全部通过，既有自动启动和 PR 归档测试共 11 项通过。
组件类型检查、格式化、静态及公共边界检查、文档检查均通过。完整 `pnpm check` 在
无关的 `boot-shell` 存储不可用用例处停止（组件测试 4590 项通过、1 项失败）。
该失败也在独立运行时复现，相关源码和测试与 main 一致；根命令后续 Electron 测试未执行。

测试证明浏览器语义和界面状态，未证明 VoiceOver/NVDA 实际朗读、打包 Electron 行为、
真实权限弹窗或投递。未使用生产账号或真实偏好。仓库检查结果记录在
[Draft PR #1191](https://github.com/LodyAI/Lody/pull/1191)。
