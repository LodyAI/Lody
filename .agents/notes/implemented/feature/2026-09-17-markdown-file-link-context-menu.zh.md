# Markdown 文件链接右键菜单

Status: implemented
Translation: current

[English](2026-09-17-markdown-file-link-context-menu.md)

## 摘要

助手 Markdown 文件链接过去只能在应用内打开预览，或在缺少预览操作时复制链接。现在链接提供右键菜单：始终可复制文件路径；只有本机 Electron 会话且工作区路径已解析时，才可打开文件、使用顶部所选编辑器打开、选择其他已配置启动器或在宿主文件管理器中显示。实现复用共享会话文件操作边界，因此远程或网页内容不会把代理提供的路径交给查看者本机 shell。行号锚点仍只用于应用内导航，并会在原生操作前移除。

## 决策与证据

`useSessionFileActions` 使用保护文件树、预览提示和侧边栏操作的同一台本机判定，构建 Markdown 专用菜单。
`SessionDetail` 通过 `SessionChatInterface` 只将该能力提供给会话消息流；其他 Markdown 渲染位置没有原生菜单。
菜单读取路径启动器偏好，因此所选启动器与会话顶部一致；“打开方式”子菜单列出其余可用的已配置启动器。

[草案 Spec](../../../../specs/local-file-link-actions.zh.md)记录用户可见契约。实现证据包括 [Markdown 渲染器](../../../../packages/components/src/components/ai-gui/markdown-renderer.tsx)、[动作 Hook](../../../../packages/components/src/hooks/use-session-file-actions.ts) 和聚焦的 [动作测试](../../../../packages/components/tests/use-session-file-actions.test.tsx)。

## 验证

已请求运行聚焦组件测试与类型检查，但该嵌套工作树缺少 `node_modules` 依赖，导致 `vitest` 和 Node 类型定义均无法找到，因而未能启动。新增测试覆盖本机与远程动作集合、原生调用前移除行号后缀，以及右键菜单的左右键鼠标行为。仍需在依赖完整的环境中运行完整验证。
