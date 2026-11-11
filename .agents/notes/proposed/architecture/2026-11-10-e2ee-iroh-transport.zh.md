# 加密工作区 RPC 经 iroh 传输

Status: proposed
Translation: current
Date: 2026-11-10

[English](2026-11-10-e2ee-iroh-transport.md)

## 摘要

加密工作区的实时 RPC 帧经 Streams 传送，依赖后端，且每次多一跳。Owner 于
2026-11-10 把 iroh 定为首选通道：桌面主进程和 CLI 按每个工作区账本设备密钥各开一个
iroh Endpoint，在 ALPN `lody/e2ee-rpc/1` 上传送相同的签名帧；Streams RPC 和持久派发
仍作为回退。可达性不需要控制面：拨号方用全部 Lody 中继寻址目标，因此不发布任何
地址，Convex 不变。延迟、打洞成功率、Windows 防火墙行为和安装包加载尚未测量。

## 问题

[foundations Spec](../../../../specs/e2ee-foundations.zh.md#首选通道iroh) 于 2026-10-28
把 iroh 移出 MVP，但保留其身份决定：EndpointId 是工作区账本设备的 Ed25519 公钥。
加密 Streams RPC 每次请求都要绕经后端，owner 希望在所有平台都能使用设备间通道后，
把它从加密工作区下掉。

## 决定

- **只做传输。** iroh 用与 Streams 相同的 `{id, frame}` JSON 信封传送现有请求帧
  （用途 8）和响应帧（用途 9）。接收方把它们交给现有接收器、journal、授权和实际
  启动 claim。对拨号方的传输层认证从不构成授权。
- **线上格式。** ALPN `lody/e2ee-rpc/1`，每个请求一条 QUIC 双向流。拨号方写一条
  大端 `u32` 长度前缀消息后结束发送；监听方写零到多条回复后结束。超过 2 MiB + 4 KiB
  的消息被拒绝。监听方最多排队 128 个未取走的请求，超出时重置流；每个对端最多
  32 条并发流。
- **路径顺序。** iroh → 加密 Streams RPC → 持久派发。已有到目标的存活连接时只走
  iroh；没有时先走 Streams RPC，同时在后台建连。iroh 失败时把同一份原件重投到
  Streams；共用的 claim 对两条路径上的到达去重。
- **身份与密钥保管。** custody 只在把设备种子导入为不可导出的 WebCrypto key 时
  短暂持有它，而 iroh 没有外接签名器的接口，因此 node custody 新增一个用途受限的
  操作：解密种子并交给原生打开函数。原生层立即擦除 JavaScript buffer，Endpoint
  关闭时擦除自己的副本；不暴露签名或导出接口，也不经过 IPC。种子只签 TLS 1.3 和
  iroh 中继握手（`iroh-relay handshake v1` 域分隔）；不使用 Pkarr 记录。进程级
  注册表保证每把设备密钥最多一个存活的 Endpoint。
- **可达性。** 每次拨号把全部已配置中继 URL 加入目标的 `EndpointAddr`；iroh 会把
  QUIC Initial 包发到所有已知路径，于是首包到达对端选作主中继的那一个。不配置 DNS、
  Pkarr 或 Convex 地址查找。目标形态是 Lody 自营、用共享 token 做访问控制的
  `iroh-relay`（部署包在私有仓）。
- **过渡期中继。** 2026-11-10 owner 决定，在 Lody 中继部署之前使用 n0 的 4 个公共
  中继（`relay.n0.iroh.link` 下的 `use1-1`、`usw1-1`、`euc1-1`、`aps1-1`，见 v1.4.1
  的 `iroh/src/defaults.rs`；无需 token）。切换只改配置（`VITE_IROH_RELAYS`）。接受
  的代价：n0 能看到设备公钥、IP 地址以及谁在和谁通信（内容仍是端到端加密）；公共
  中继有限流、没有可用性保证；n0 会按版本线下线公共中继，例如已宣布 0.35 线于
  2026-12-31 下线。
- **能力边界。** 中继 URL 和 token 只来自官方发布构建的组合。仅本地运行的桌面版和
  没有原生模块的宿主没有 iroh 能力，继续使用现有路径。
- **生命周期。** 机器端 Endpoint 是 `apps/cli/src/lib/e2ee/workspace-legacy.ts` 中
  `startRpc` 在 Streams 监听旁另起的 fiber，两者各自失败、各自重启（iroh 每 30 秒
  重试），互不影响；`stopRpc` 同时中断两者，Endpoint 在 finalizer 中关闭。桌面端
  Endpoint 在 `apps/electron/src/main/services/e2ee-runtime.mts` 的工作区条目里首次
  使用时打开、随条目关闭，因此跟随 reader 租约，不需要单独的空闲计时器。
- **首版范围。** dispatch 和单帧 feature 请求走 iroh。分块的 feature 请求仍走
  Streams，因为它的接收方要跨信封重组分块；要放进一条 QUIC 流需要改接收方。
- **加载。** JavaScript 加载器只接受明确的文件路径。云端桌面构建把
  `lody-iroh.<platform>-<arch>.node` 放进应用资源目录；主进程从那里加载，并把
  `LODY_IROH_NATIVE_PATH` 和中继设置传给内嵌 CLI。公开桌面版和独立 npm CLI 不带
  该模块。
- **原生代码。** `packages/iroh-native` 包含与平台无关的 `lody-iroh` crate 和一个
  napi-rs 绑定。移动端使用同一 crate 的 UniFFI 绑定（`uniffi/`），只拨号，关闭端口映射。
- **移动端种子交接。** 移动 App 在 WebView 里运行 portable host，它本来就持有设备种子。
  `BrowserDevice.withTransportSeed` 每个会话把一份副本交给一个原生插件一次（打开、
  状态、发送、接收），插件从不回传种子。Capacitor 会序列化参数，因此会留下一份无法
  擦除的 JavaScript 种子字符串，直到被垃圾回收；owner 接受这一代价（2026-11-10）。

## 依据

检查过的 iroh v1.4.1 源码：

- `iroh/src/socket/transports/relay/actor.rs`（`active_relay_handle_for_endpoint`）：
  拨号方会连接目标地址里写明的任意中继 URL。
- `iroh/src/socket/remote_map/remote_state.rs`：尚未选定路径时，Initial 包发往所有
  已知路径。
- `iroh-relay/src/protos/handshake.rs`：中继认证签的是 BLAKE3 派生的 challenge
  或 16 字节 TLS 导出密钥材料，两者都有域分隔。
- `iroh/src/tls.rs`：1.x 的 TLS 使用 RFC 7250 裸公钥。
- `iroh-base/src/key.rs`：`SecretKey::from_bytes(&[u8; 32])`。

外部事实：

- [iroh #3813](https://github.com/n0-computer/iroh/issues/3813) 说明两个 Endpoint
  共用一把密钥会导致中继互相踢下线。
- [GHSA-7cq4-mhxw-xw78](https://github.com/n0-computer/iroh/security/advisories/GHSA-7cq4-mhxw-xw78)
  （1.1.0 修复）决定了 1.4.1 这一最低版本。
- [fedimint #9378](https://github.com/fedimint/fedimint/issues/9378) 记录了端口映射
  在 iOS 上引发「本地网络」权限弹窗。
- n0 文档说明公共中继限流，不建议用于生产。

## 备选方案

- **Tailcat**（Tailscale，2026）：WireGuard Curve25519 身份不能复用账本 Ed25519
  密钥，需要已被否决的独立网络密钥；而且是没有稳定性承诺的实验性 Go 库。
- **在 Convex 发布地址。** 多中继拨号已能到达每个对端，再发布地址只会增加后端
  状态和耦合。
- **n0 DNS/Pkarr 地址查找。** 会让设备密钥多签第三种协议，并依赖第三方。
- **官方 iroh-ffi 移动绑定。** 默认 feature 开启端口映射（iOS 本地网络弹窗）和
  `fast-apple-datapath`（苹果私有 API），且没有暴露开关。
- **浏览器版 iroh。** 只能走中继且没有官方包，owner 决定不做。
- **在移动端 WebView 里运行编译成 WebAssembly 的 iroh。** 试验（iroh 1.4.1、`tls-ring`、
  gzip 后 0.97 MB）在 WebKit（355 ms）和 Chromium（319 ms）里跑通了只走中继的往返，
  种子也不经过 bridge，但只能走中继、没有直连。owner 为了直连选择了原生插件。

## 影响

- 拨号方会和每个已配置中继保持连接。某个中继故障只影响挂在它上面的设备，直到
  它们换到别的中继。
- 共享中继 token 只能通过重新部署轮换；出现滥用时改为回调鉴权。
- 从加密工作区下掉 Streams RPC，要等所有支持的平台都迁移并验证兼容后，再修订
  Spec。

## 验证

- `packages/iroh-native/core/src/tests.rs` 覆盖多回复调用、连接复用、拨通挂在拨号方
  所列中继之一上的对端、一钥一 Endpoint 规则、超大请求、不可达对端和被拒绝的流。
- `packages/iroh-native/test/endpoint.test.ts` 覆盖绑定层：种子擦除、一钥一
  Endpoint、无效种子和关闭。
- `apps/cli/src/lib/e2ee/realtime-rpc.test.ts` 让一份签名原件经真实 iroh 监听器和
  真实接收器处理并验证 ACK，再把同一原件经 Streams 送达，确认只 offer 一次。
- `apps/cli/tests/e2ee-runtime.test.ts` 通过 CLI custody 打开 Endpoint，确认
  EndpointId 就是账本设备密钥，且种子已被擦除。
- `packages/components/tests/encrypted-dispatch-legacy.test.ts` 覆盖路径选择：有存活
  连接时走 iroh；没有连接、调用失败或没有可验证回复时用同一原件改走 Streams；分块
  原件留在 Streams。
- 2026-11-10 本地探索式验收（macOS arm64，HTTPS/h2 本地栈，云端桌面 test-build，内嵌
  CLI，n0 公共中继，head `39e57c00`）：同一加密会话的 3 条消息各执行一次，且每条都有
  对应的 CLI `[e2ee-iroh] request` 和渲染进程 `iroh-reply`；agent 改文件后能看到真实
  diff 和文件预览；能力刷新（一个 feature 请求）经 iroh 回复；去掉模块后 CLI 退回
  Streams 且只执行一次。这不是干净的脚本化运行，也没有证明 diff/预览内容本身经 iroh。
- 该运行发现并在本 PR 修复了两个缺陷：macOS 上 Cargo 的 strip 步骤生成了 Node 和
  Electron 拒绝加载的 dylib（`mis-aligned LINKEDIT string pool`）；在只能经 HTTP 代理
  出网的网络里，Endpoint 不走代理就连不上中继（直连 `iroh_connect_timeout`；经
  `127.0.0.1:1087` 两端都 online，约 937 ms 收到回复）。
- 尚未验证：桌面客户端连接已部署的中继；直连、只走中继和 Streams 三种路径的发送
  到实际启动延迟；打洞成功率；监听机器上的 Windows 防火墙弹窗；各平台安装包里原生
  模块的加载和 macOS 签名。
