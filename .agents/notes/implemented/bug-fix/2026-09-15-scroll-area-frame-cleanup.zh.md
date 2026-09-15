# 清理 ScrollArea 滑块的帧轮询

Status: implemented
Translation: current

[English](2026-09-15-scroll-area-frame-cleanup.md)

## 摘要

Radix ScrollArea 1.2.10 的滑块在滚动结束防抖期间卸载时，可能留下递归动画帧循环，持续读取已脱离文档的 viewport。本次通过 pnpm 补丁，在所属 effect 的清理阶段取消循环，同时覆盖 ESM 和 CommonJS，保留正常滚动时的轮询。真实组件回归测试在移除补丁时重现缺陷，恢复补丁后通过；尚未测量运行中桌面应用的能耗降幅。

## 决策

通过 pnpm 按版本绑定的 patchedDependencies 应用[依赖补丁](../../../../patches/@radix-ui__react-scroll-area@1.2.10.patch)。清理过程移除滚动事件监听、取消滑块正在运行的帧循环，并清空取消函数引用，也覆盖 effect 依赖变化。正常滚动结束时，原有防抖回调会取消轮询；但卸载会清除防抖定时器，因此卸载清理必须由 effect 自身负责。

保留 Radix 和现有滚动行为。改用原生滚动条或 Base UI 会扩大改动，需要额外验证交互和样式。只有上游版本提供等效清理且通过[生命周期测试](../../../../packages/components/tests/scroll-area-lifecycle.test.tsx)后才移除补丁；升级规则放在 [UI 指南](../../../../packages/components/src/ui/AGENTS.md#scroll-area)。

## 验证与限制

- 使用真实 React 19.2.0 和 Radix 1.2.10 组件，在 jsdom 中手动推进动画帧和模拟定时器，不依赖真实等待或调度时机。
- 两种模块入口均在滚动结束后停止轮询，并在再次滚动时恢复。
- 重复十次挂载、滚动、卸载后，再推进 120 帧，不再读取脱离文档的 viewport，也没有残留帧回调。
- 移除补丁后，两项卸载测试失败，两项正常滚动测试通过；恢复后四项全部通过。
- pnpm 10.20.0 在隔离安装中成功应用补丁并生成锁文件哈希。仓库缺少 ACP 工作区子模块，完整依赖安装受阻，未运行全项目测试。
- 未重新构建或重启运行中的应用。验证证明生命周期泄漏及其修复，不能证明它占 renderer CPU 或 Energy Impact 的具体比例。
