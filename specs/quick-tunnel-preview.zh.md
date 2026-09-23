# Quick Tunnel 预览

Status: draft
Translation: current

[English](quick-tunnel-preview.md)

用户可自行启动开发服务器，并在 Session Browser 提交 `localhost:5173`。
地址始终指向 Session 所属机器。回车即授权准确的 loopback origin，不启动
开发服务器，也不另弹确认框。Agent 建议、输入过程和面板挂载不能授权公网暴露。

## 归属与访问

CLI 拥有目标绑定的 HTTP/WebSocket 代理、endpoint 凭据和 cloudflared 子进程。
本机浏览使用独立 loopback endpoint，不依赖云端；远端直接使用临时 Quick Tunnel，
不保留 Worker 网关、自定义传输协议、旧链接映射或回退路径。两类入口共享转发代码，
不共享凭据或监听端口。

Share 创建或复用该 Session 唯一的远端 endpoint，并复制带 capability 的 URL。
持有链接的人无需登录 Lody 即可访问和操作。每次 HTTP 请求与 WS upgrade 均需鉴权；
同源 Origin 或无 token 的 Referer 不构成授权。链接持有者不能创建、恢复或改变
隧道目标；这些控制操作仅允许已鉴权且有该 Session 操作权限的用户执行。

远端控制要求机器声明 `previewControl` 协议能力 v1。独立的
`machine/preview-control` 握手提供签名控制证明所需的 runtime nonce，
不授予访问权限，也不创建入口。通用 `machine/status` 响应保持不变，避免
破坏旧客户端；不支持该能力的机器明确要求升级，不回退旧 Preview。

仅允许精确 localhost 或 literal loopback 目标，请求始终绑定已授权 origin。
探测和实际转发使用同一 literal loopback 地址，保留已授权的 Host 与 TLS 身份；
环境中的 DNS 或 HTTP 代理设置不能改变本地目标流量的去向。
凭据不得进入开发服务器、Annotation 数据、日志或导航历史。撤销先使凭据失效，
关闭在途请求和 socket，再释放本产品拥有的资源。

HTTP/WS 转发仅将与已绑定 viewer origin 精确相等的 Origin 映射回已授权本地
origin，与 Host/Referer 转换保持一致。第三方、opaque 与缺失 Origin 原样保留，
应用跨站检查仍然生效。映射不能替代 endpoint 凭据，也不要求放宽开发服务器的
origin allowlist。

## 生命周期与 Browser

每个原生 connector 及其临时配置由轻量生命周期子进程持有。正常关闭或 CLI 的
私有 IPC 断开时释放这些资源，包括 CLI 被强制结束的情况。该子进程不轮询、
不自动重启，也不拥有开发服务器。关闭完成必须等待进程实际退出；清理失败
明确报错。不承诺生命周期子进程自身被强制结束后的回收。

远端状态为 `creating`、`active`、带原因的 `closed` 或 `failed`。公开 HTTP
往返验证成功后才能 active，与可选 Annotation 独立。错误保留原因，不自动替换
隧道或静默切换传输；同一 Session 的创建与关闭串行处理。
前台 Browser 状态刷新以有界公网检查验证可达性，不以子进程存活代替链路健康。
检查失败呈现失败和恢复入口；代理成功转发的应用 4xx/5xx 不是隧道故障。
检查不能续期，也不能覆盖更新的 endpoint。

远端闲置超时为一小时。有效 HTTP 请求、应用 WS 数据和前台远端 Browser 的低频
控制保活可续期。探活、状态查询、无效请求、协议 ping/pong、隐藏面板及本机浏览
不续期。迟到请求不能复活过期入口；活动时间保留在 CLI 内存，不高频写共享文档。

Browser 用一个地址栏状态控件呈现连接状态，以不同图标和可访问名称区分状态；
点击后显示简短状态、本地/远端关系、相关诊断，以及适用的恢复或停止分享操作。
它保留以下必要事实：回车授权准确的 localhost 目标、持有链接的人可以访问分享
预览、远端分享闲置 1 小时后关闭。远端过期或失败时以原因和一键恢复按钮替代失效
内容，保留开发地址、路径与查询。恢复是新授权，加载新 endpoint，不重放应用操作。
恢复后说明分享链接已更新，并提供复制。机器离线或 Session 结束时说明无法恢复的
原因。关闭远端分享不影响本机浏览或用户开发服务器；面板卸载不关闭 endpoint。

## 边界与验证

Quick Tunnel 地址临时、无 SLA、上限为 200 个在途请求，且不支持 SSE；异常明确
呈现。cloudflared 使用产品管理的固定版本并校验完整性，不调用未知 PATH 二进制或
安装系统服务。不包含 iOS 模拟器，也不新增应用 Cookie/OAuth 兼容承诺。

实施进行中。验收需要 HTTP/WS 行为测试、确定性的闲置/取消测试、支持客户端的真实
iframe 鉴权、Browser 恢复测试、二进制生命周期验证，以及独立实网性能测量。
仅代理测试通过不代表整体完成。

证据：[CLI Preview](../apps/cli/src/preview/AGENTS.md)、
[Annotation 契约](preview-annotation-availability.zh.md)。
