# 本机 IPC 与原生 HTML 预览边界

Status: implemented
Translation: current

[English](2026-11-12-local-ipc-and-native-preview-security.md)

## 摘要

可预测的 Windows 控制和数据面管道名不足以提供鉴权。Daemon 通过私有运行文件发布随机管道地址和独立的进程秘密，控制、探测与数据面服务在分发前验证秘密。原生 iOS HTML 预览保留 HTTPS 静态资源，同时禁止主动连接、表单、嵌套文档和页面跳转。这些限制减少指定外传通道，但允许任意 HTTPS 静态资源就不能保证完整的数据隔离。

## 决策

`daemon.json` 在私有运行目录内以 `0600` 权限原子发布 Token 和端点地址。Windows 管道后缀与 Token 各使用独立的 256 位随机数。HTTP 使用 `x-lody-local-token`；数据面先发送 `authenticate`，收到 `authenticated` 后 Electron 才报告已连接并转发渲染进程消息。缺失、错误或格式异常的秘密被拒绝，对合法长度的 Token 使用常量时间比较。未鉴权连接受首包大小和等待时间限制。

客户端一并发现地址与凭据。HTTP 缓存在连接失败或明确的本地鉴权拒绝后失效。只有已缓存端点发生建连前的 `ENOENT`/`ECONNREFUSED`，或收到服务端业务分发前的 `local_ipc_unauthorized`，且发布的地址或 Token 已变化时，才自动重试一次。超时、连接建立后的断连和业务鉴权失败均不重放请求。Electron 每次重拨重新读取运行文件。内置 stdio 与 HTTP MCP 按需发现控制端点；stdio 透传平台和数据目录选项，显式 socket 覆盖在默认元数据不可读时仍可使用，但不借用其中的 Token。未提供秘密的旧客户端不能访问加固后的服务，安装时需要同时更新两端。命名管道鉴权并不会使 Windows 文件权限位变成 ACL，部署仍需保留用户私有配置目录的 ACL。跨权限级别共享、Host 租约和终端协议属于独立边界。

原生预览始终在原始内容前添加 CSP，文档自带的宽松策略不能放开通道，更严策略仍然生效。可信 `RuntimeDocument` 数据运行时保留正常云连接。预览导航只允许初始文档与同文档锚点，链接和弹窗不能静默启动外部浏览器。没有采用删除 HTTPS 脚本和图片的方案，因为它会破坏已选定的 CDN 渲染体验；这些允许的资源请求仍可在 URL 中携带数据，第三方脚本仍能在预览内运行。

## 验证边界

现有 IPC 和数据面测试使用真实 socket 验证拒绝与成功分发；relay 测试覆盖等待握手和连接替换。`RuntimeContractTests` 在 WebKit 中验证预览策略，包括静态 JavaScript/CSS，以及主动连接和表单触发的 CSP 拒绝事件。这些检查不证明 Windows ACL 行为、真实 CDN 可用性或原生设备验收。
