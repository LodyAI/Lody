# Lody 深链接

Status: draft
Translation: current

[English](deep-links.md)

用户点击会话引用时，在当前 Lody 中打开准确的会话；从其他应用点击复制链接时，由系统默认的 Lody 安装处理。所有版本生成同一种资源链接。链接标识目的地，不授予访问权。

## 地址与版本

| 用途               | 地址                                                            |
| ------------------ | --------------------------------------------------------------- |
| 会话（所有版本）   | `lody://session/<sessionId>?workspace=<workspaceId>`            |
| Stable 新登录回调  | `ai.lody.stable://auth/callback#token=…`                        |
| Nightly 登录回调   | `ai.lody.nightly://auth/callback#token=…`                       |

workspace 使用稳定 ID；UI 解析为当前 slug。复制、mention 和 Markdown 导出的所有新链接都直接使用目标对话的真实 ID。父子关系和 UI 标签属于内部导航细节，不是公开地址的一部分。早期 root+tab 链接仅保留读取兼容，重新生成或导出时转换为直接目标 ID，不再输出 tab 参数。裸 ID 和不带 workspace 的旧引用只在既有调用上下文解析，不跨安装搜索。

`lody-oss://session/…`、`ai.lody.nightly://session/…` 和 `ai.lody.stable://session/…` 仅作为定向打开入口；新资源链接统一生成 `lody://`。保留应用内旧 `session://<id>` 读取兼容，不注册 OS 的 session 协议，不重写历史。消息复制和 UI/CLI Markdown 导出将正文引用转换成统一协议，仅在来源 workspace 已知时补上缺失的 ID。保留显式外部 workspace ID、代码示例和工具数据。匿名导出不从访问者推断来源 workspace；编辑重发保留存储原文。应用外旧链接无法保证打开 Lody。

系统只选择一个默认资源处理应用。设置 → 关于提供“设为默认”；启动不能覆盖已有公共处理程序。Windows 安装包启动就绪后仅在没有处理程序时注册公共协议；这修复首次启动后的状态，不保证首次启动前可分发。安装包声明公共协议和所属版本专属协议，首次安装与用户选择的最终效果由 OS 决定。AppImage 的桌面文件声明两者，只有用户明确选择才更新公共默认项。

认证不走资源路由。新 Stable 登录显式传 stable channel 并返回 `ai.lody.stable`；Nightly 仍返回 `ai.lody.nightly`。未带 channel 的旧浏览器调用仍生成旧 `lody` 回调，Stable 保留接收兼容。非 Stable 版本把公共协议的旧认证、邀请、GitHub 安装、checkout 和 machine-connect 路由转发到 Stable 专属别名，不在本版本交换凭据。没有处理程序、交接失败或未知路由时显示不含敏感信息的错误。`chat/new` 留在系统选择的安装中。OSS 保留 `lody-oss` 私有入口，不启动云认证。

## 分发与访问

```text
mention / 复制 → 共享 builder → lody://session/…
Markdown 点击 → 当前会话导航
系统 URL / 产品窗口链接 → 当前安装的 renderer 队列
                         ↓
                 就绪的 workspace 目录
                         ↓
                session 路由与子标签恢复
```

普通应用内点击留在来源窗口，产品窗口的导航、新窗口链接和外链 IPC 优先解析会话资源。合法资源不交给系统重启自身。公开分享上的私有会话引用保持不可点击；公共嵌入浏览器不获得产品导航权限。其他外链保留 HTTP(S) 策略。

OS URL 使用现有桌面窗口生命周期和 preload 缓冲，renderer 在工作区目录与当前 workspace 就绪后消费导航意图。显式目标编码成具体 tab，不能被上次访问标签覆盖；目标页 metadata 就绪后复用现有标签恢复逻辑。资源请求等待期间最新目标优先；这不是跨主进程崩溃的持久队列。

workspace 不可用时不回退当前 workspace，显示错误和已注册其他版本的显式打开动作。会话资源切换版本必须由用户点击，不能自动绕过权限。OSS 仅查询本地目录。会话访问控制、删除/加载/离线状态和归档语义由现有会话页面处理；链接不会自动解除归档。待恢复的会话会等待子会话元数据，15 秒后超时清理并显示错误，放弃导航时也清理。现有系统入口仍使用主窗口，不新增跨窗口 workspace 目录。

## MCP、粘贴与校验

共享的纯 builder/parser 由 `@lody/shared/session-link` 提供。MCP 参数与说明支持完整新 URI、旧 URI 和裸 ID；显式 workspace 必须匹配授权上下文。MCP 不接受 root+tab 复合选择，提示直接使用子会话 ID；UI 生产者已生成直接子 ID。

批量状态中的无效引用逐项返回 `SESSION_NOT_FOUND`，不影响有效条目。新 URI 粘贴仅在同 workspace 转成 mention，root+tab 复合链接使用子会话 ID。已有 HTTPS 会话地址继续按受信 origin 识别；Cmd/Ctrl+Shift+V 保留纯文本。公开分享依然走独立 HTTPS 分享流程；复制会话链接不发布内容。

解析最多 8 KiB，只接受已知 scheme、session 资源、ASCII ID 和 workspace/tab 参数。拒绝凭据、端口、重复/未知参数、fragment、空 ID、路径遍历、空白、反斜杠和百分号编码。ID 保持大小写；限定字符集不需要百分号编码。路径/query 不直接作为任意 UI 路由或命令执行。

## 验收与发布边界

验证新旧格式、带 workspace 的 mention/复制、MCP 跨 workspace 拒绝、同工作区粘贴、匿名分享不可点击、公共协议不被启动覆盖，以及版本回调隔离。源码测试使用确定性事件和注入状态，不用真实 sleep。

先升级消费者（共享 UI、桌面入口、MCP、浏览器认证回调页），再发布生成新链接的客户端。旧 MCP 可使用裸会话 ID读取本工作区会话，但不能理解新 URI；新客户端与旧 daemon 混用存在兼容限制。旧客户端不能读取新链接，需发布说明。

公开仓库实现共享代码和 OSS 打包配置。复用 beforePack 的打包流程自动补齐公共协议及本版本回调协议；其他渠道若覆盖该钩子，必须在其所属构建中声明相同协议。真正的 macOS/Windows/Linux 冷热启动、默认程序选择、安装器升级及托管认证网页部署仍需发布验收；单元测试不证明这些行为。

## 证据

- [决策与验证](../.agents/notes/implemented/architecture/2026-09-29-lody-deep-links.zh.md)。
- [桌面登录](desktop-browser-login.zh.md)、[默认首页](app-startup-landing.zh.md)。
- [Electron 深链接机制](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)。
