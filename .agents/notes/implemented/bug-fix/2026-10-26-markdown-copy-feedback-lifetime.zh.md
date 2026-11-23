# Markdown 复制反馈随链接卸载而结束

Status: implemented
Translation: current

[English](2026-10-26-markdown-copy-feedback-lifetime.md)

## 摘要

复制 Markdown 文件路径后，反馈定时器会在链接卸载后继续运行，可能在浏览器测试环境关闭后更新 React 状态。
现在由已挂载链接的 effect 管理定时器，并在清理时取消；原有的 1,200 毫秒反馈保持不变。
剪贴板写入和打开文件的行为不变。

## 归属与证据

`markdown-renderer.tsx` 的 `AgentFileLink` 同时拥有复制提示和重置操作。
链接消失后已没有需要重置的提示，因此不需要全局回调继续存活。
这遵循[生命周期错误隔离约定](../../../docs/failure-containment.md)。

现有 `markdown-agent-file-chip` 测试挂载真实链接，复制合成路径，用假时钟确认提示重置，再复制并卸载。
修复前留下一个定时器，修复后不再留下定时器；相关 Markdown 与会话文件测试通过。
这些证据验证 UI 定时器清理，不代表原生剪贴板集成已验证。
该问题在验证[安全 PR #1891](https://github.com/LodyAI/Lody/pull/1891) 时暴露，与依赖补丁是不同问题。
