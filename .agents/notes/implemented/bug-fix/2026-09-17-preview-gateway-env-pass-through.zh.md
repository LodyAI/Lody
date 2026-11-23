# 把显式的 preview gateway URL 传给内嵌 CLI

Status: implemented
Translation: current

[English](2026-09-17-preview-gateway-env-pass-through.md)

## 摘要

Electron Cloud 构建此前只把 `VITE_SERVER_URL` 作为 `LODY_SERVER_URL` 转发给内嵌 CLI。
CLI 已经支持独立的 `LODY_PREVIEW_GATEWAY_URL`，但 Electron 从未提供它，所以在 staging 上
创建 tunnel 时会回退到 staging server origin，而 Worker 只接受当前环境配置的 staging
control origin，最终返回 421 `preview_control_origin_mismatch`。现在 Electron 始终把
`VITE_PREVIEW_GATEWAY_URL` 写入 `LODY_PREVIEW_GATEWAY_URL`（bundle 中没有值时写入空字符串，
CLI 会回退到 `LODY_SERVER_URL`）。始终写入也能阻止继承来的 shell 变量把需要鉴权的 tunnel
请求重定向到其他 origin。这样既不影响生产，也不用放松 Worker 的安全边界。

## 原因与决策

preview gateway 刻意只接受当前环境的 `PUBLIC_PREVIEW_CONTROL_ORIGIN`。生产恰好让 server
和 preview control plane 使用同一个 origin，而 staging 的两个 origin 不同。CLI composition
早已把 `previewGatewayUrl` 设计成可选的显式端口，默认回退到 `LODY_SERVER_URL`，且
`start.ts` 会读取 `process.env.LODY_PREVIEW_GATEWAY_URL`。独立 CLI 构建可以把这个值
inline 进去，但 Electron composition 启动 CLI 时使用的运行时环境只列出了 auth 和 server
URL。只要 staging 的 `LODY_SERVER_URL` 是 Worker 公开的 `workers.dev` origin，Electron
创建 tunnel 就必然发到一个被 Worker 按设计拒绝的 origin。

让 Worker 接受 `workers.dev` 会破坏 control/viewer origin 的隔离，并引入生产没有的第二种
staging 行为。因此这里选择让 Electron 转发 CLI 已经具备的显式能力。即使 bundle 中没有值也
写入该 key 是有意为之：CLI 会回退到 `LODY_SERVER_URL`，而用户登录 shell 中的
`LODY_PREVIEW_GATEWAY_URL` 无法覆盖 composition 指定的 control origin。生产的回退语义仍
然保留，本地 OSS composition 也会在任何 cloud 环境赋值之前返回。server 与 control origin
不同的环境由 composition root 显式设置变量。

## 验证

公开改动是 `apps/electron/src/main/services/cli-service.ts` 中的一处运行时环境赋值，以及
`apps/electron/src/main/env.d.ts` 中的 Vite 类型声明。类型检查与受影响的私有 composition
检查会覆盖新的 `VITE_*` define 和运行时赋值能一起编译。本次没有产出 staging Electron
打包件，因此端到端 tunnel handshake 需要在私有 composition 通过
`LODY_PREVIEW_GATEWAY_URL` 设置 staging control origin 后另行验证。

## 集成

- [Lody PR #793](https://github.com/LodyAI/Lody/pull/793)
- 与私有 preview gateway 配置改动一起提交。
