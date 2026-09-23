# 侧边会话 Markdown 文件链接能力作用域

Status: implemented
Translation: current

[English](2026-09-17-side-session-file-link-capability-scope.md)

## 摘要

Markdown 文件链接菜单最初通过共享会话界面 helper 接收根会话的文件操作回调。因此，远程侧边会话可能展示只获本机根会话授权的原生操作，并把目标指向根工作区。菜单 provider 现在从其渲染的会话自身推导操作；远程侧边会话只能复制路径，不能调用本机 Electron bridge。这是对原 [功能记录](../feature/2026-09-17-markdown-file-link-context-menu.zh.md) 的修正。

## 决策与证据

`SessionChatInterface` 现在拥有 `SessionAgentFileLinkMenuProvider` 这一边界，而不再接收 `SessionDetail` 选择的回调。provider 使用正在渲染的 `SessionMeta`，现有文件操作解析器因此会把“当前机器”和“工作区路径已解析”的门控应用于这个准确的会话。即使发起会话在本机而子会话或侧边会话的机器、工作区不同，已挂载的聊天界面也不会越权。

行为测试同时渲染本机根会话和远程 `side-panel` 会话，断言根会话可展示“打开文件”，而侧边菜单严格只有“复制路径”；随后触发复制路径并确认没有本机打开、显示或启动器 IPC。用户可见契约已更新至 [本地文件链接 Spec](../../../../specs/local-file-link-actions.zh.md)。PR：[#789](https://github.com/LodyAI/Lody/pull/789)。

## 验证

请在已安装工作区依赖的环境运行聚焦 provider 回归测试和 i18n 检查。此嵌套工作树没有 `node_modules`，无法在本地运行类型检查和格式化；CI 仍是完整的依赖环境验证。
