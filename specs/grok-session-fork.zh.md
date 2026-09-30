# Grok 会话分叉

Status: draft
Translation: current

[English](grok-session-fork.md)

## 场景

用户在新会话中继续 Grok 对话，可以从当前末尾或选定的历史 prompt 轮次之后分叉，
也可以切换工作目录。源会话继续可用，不会被取消或重新加载。

## 契约

Grok 适配器暴露标准 ACP `session/fork` 和 Core 的版本 1
`_meta.lody.forkAtTurn`。不指定目标时复制已持久化的对话；指定适配器发出的
`turnId` 时，请求 Grok 复制包含目标 prompt 及其助手输出的历史前缀。
边界是原生 prompt 轮次，不是任意文本片段或工具事件。
运行中会话的复制内容以 Grok 在复制时已持久化的状态为准。

适配器从实时及回放更新中的原生 prompt 标记发布 `_meta.lody.turnId`。
这些不透明 ID 保留原生 prompt 坐标，适配器重启后仍可使用；宿主必须原样传递。
缺少原生标记的旧历史不会被人为补出边界。原生 rewind 会改变分支内的坐标空间，
调用者必须使用当前历史中的边界。

请求的 `cwd` 属于子会话。适配器通过运行时的分页会话列表查找源目录，再请求
运行时复制自身持久化状态。随后不回放地接入子会话，保留目标 MCP 配置及启动
权限策略。源会话定位、复制和接入全部成功后才能报告分叉成功。失败不能静默
创建空白会话，也不能忽略格式错误的目标。复制成功但接入失败时，错误中携带
已创建的子会话 ID，供恢复使用。

适配器负责 Grok 私有协议转换。Core 共享契约及 Lody 宿主、界面不引入 Grok
专用的分叉请求或存储格式。分叉本身不创建 git worktree、不恢复项目文件，也
不启动模型 prompt。

## 证据与限制

- [Core 契约](../packages/acp-extension-core/README.md)与
  [Grok 适配器](../packages/acp-extension-grok/README.md#session-forks)。
- [实现与验证记录](../.agents/notes/implemented/feature/2026-09-24-grok-session-fork.zh.md)。
- 自动化适配器测试使用合成协议交换。可选的原生探针在 Grok 1.0.34、1.0.40
  验证完整和部分持久化复制，以及源会话不变。尚未端到端验证鉴权后的子会话
  继续对话、运行中并发持久化以及跨压缩历史的分叉。
