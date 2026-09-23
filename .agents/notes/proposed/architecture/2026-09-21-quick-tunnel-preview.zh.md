# 直连 Quick Tunnel 预览

Status: proposed
Translation: current

[English](2026-09-21-quick-tunnel-preview.md)

PR: [#890](https://github.com/LodyAI/Lody/pull/890)

## 摘要

现有预览网关通过产品自建 WebSocket 协议复用 HTTP 与 HMR，本机代理也依赖该
传输文件里的通用工具。替换方案将 endpoint 鉴权和生命周期集中到 CLI，由
cloudflared 提供远端传输，与独立本机入口共用标准代理。分享链接是 bearer
capability，远端闲置一小时后由 Browser 引导用户显式恢复。实施尚未完成，
真实 iframe/WS 凭据行为和实网性能仍是验收门槛，不是已确认收益。

## 决策与进度

PR 审阅发现混合版本回归：向 `machine/status` 添加 `previewControlNonce`
会使旧客户端的严格校验拒绝本来有效的状态响应，实际返回 `invalid_result`，
而非评论所述的超时。通用响应保持原样，nonce 改由独立
`machine/preview-control` 获取，以共享的 `previewControl: 1` 能力检查为前提。
不支持时要求升级，本地控制与签名证明校验保持不变。这是保护通用协议，
不是保留旧 Preview 传输。

目标架构不保留薄 Worker、兼容 reader、旧域名映射或自动回退，见
[契约草案](../../../../specs/quick-tunnel-preview.zh.md)。通用工具已拆到
`preview-http.ts`，本机代理的全局解锁已删除：成功导航之后的每次请求仍需凭据。
独立监听端口/token 和显式外部 origin 绑定构成新远端入口的边界。
CLI service 现在只创建 Quick Tunnel；旧自定义隧道客户端已删除，通用转发测试移到
实际归属文件。

`QuickTunnelSession` 拥有创建、远端代理、cloudflared、就绪检查与一小时闲置到期。
取消/退出会使访问失效，并等待资源清理。Service 串行发布生命周期，撤销先取消
创建，且与创建一样检查 Session 发起者身份。拒绝的请求不会覆盖已有有效状态。
机器配额只保存在持有单一 Host lease 的 Worker 内存中；删除 PID/磁盘注册表和
旧 metadata reader。连接状态现使用 endpoint 身份和明确关闭原因；Machine RPC
状态查询/保活按目标的本地或远端平面选路，观察不续期，续期必须指定当前 endpoint。
Browser 回车、Share、恢复不再弹确认框；显示本地化状态，到期保留逻辑地址，恢复
时显式替换 endpoint，迟到状态响应不能覆盖已完成的控制操作。

WS 转发等待上游接受后才升级浏览器连接，保留选定子协议，以背压取代无限启动队列。
撤销关闭拥有的 socket 并取消请求。继续保留此前
[Fetch Metadata 决策](../../implemented/bug-fix/2026-09-20-preview-fetch-metadata.zh.md)和
[可选 Annotation 决策](../../implemented/bug-fix/2026-09-15-preview-optional-annotation.zh.md)中的约束。

`cloudflared-native.ts` 拥有固定版本子进程、显式隔离配置、有界地址分配、取消和
确认退出后的清理。2026.9.1 的 JSON 参数实际为 `--output json`；原生冒烟在接线前
发现并纠正了错误参数。公网就绪检查仅在 20 秒内重试暂时网络/DNS 或 Cloudflare
网关尚不可用的响应。转发成功以代理 marker 为准，不依赖 Annotation marker 或
进程存活；探活与可续期活动分开标识。

二进制工具沿用 profile runtime 缓存、文件锁、HTTP 代理传输和公开 R2 通道。
manifest 固定六个平台条目的上游字节（Windows ARM64 明确使用官方 x64 二进制及
系统模拟执行，该平台仍需运行验证）。私有分发脚本支持原样镜像 cloudflared，
不覆盖已有但不匹配的不可变对象。

全部 65 项 Preview 测试及 CLI 类型检查通过，包括确定性的闲置到期、迟到创建取消、
失败清理和本机浏览独立性验证。分发脚本
`--runtime cloudflared --skip-upload` 已下载并验证所有平台条目，没有上传对象。
原生 macOS ARM64 二进制已完成安装、隔离配置启动、真实 Quick URL 分配及退出清理。
直接请求和配置 HTTP 代理传输后的公网往返均超时。显式 opt-in 的
`tests/e2e/quick-tunnel.e2e.test.ts` 在 `--protocol auto` 下复现 20 秒就绪超时，
资源随后清理；故障网络段尚未确定，地址分配不算端到端通过。运行时使用
`LODY_E2E=1 LODY_QUICK_TUNNEL_E2E=1`；额外显式设置
`LODY_QUICK_TUNNEL_E2E_USE_UPSTREAM=1` 可在通道发布前验证固定上游字节，
但不证明生产制品路由已就绪。测试仅暴露合成服务；就绪失败之后的 HTTP/WS/撤销
断言尚未执行。

Browser controller 的 24 项测试覆盖前台续期、后台观察、本地浏览独立性、原页面
恢复和迟到响应隔离，相关 surface/URL/选路 18 项测试及新增客户端到服务端状态
往返测试通过。组件、共享、CLI、RPC 类型检查通过；专用 Storybook 已检查中英文、
窄屏、过期与离线禁用恢复状态。这不等于完整产品或真实隧道验收。

安全检查发现 workspace RPC 不能认证自报用户 ID。远端创建、撤销、状态查询现已
要求由应用登录态签发的两分钟操作证明，绑定准确命令、用户、workspace/machine/session、
当前运行实例 nonce 与一次性 request ID。CLI 验证机器/项目权限，项目身份取自 CLI
解析的 Session metadata。并发重复最多执行一次，重启后的新 nonce 拒绝保留的旧请求，
无需持久化 grant/重放表。登录凭据不进入共享 RPC，本机控制不依赖云端证明。
这些边界、HTTP 签发/校验、无效请求脱敏和本地独立性已有行为测试。该控制服务
与 CLI 拥有的页面访问 capability 分开，不恢复数据网关。

旧共享传输协议和 Preview 域名/构建参数已删除；Cloud CSP 允许 Quick 来源，
公共桌面版仍只允许本地 frame。这取代了历史
[gateway 环境变量修复](../../implemented/bug-fix/2026-09-17-preview-gateway-env-pass-through.zh.md)中的配置需求。
状态查询现在以最多五秒的公网检查验证活跃链路；并发查询共用探活，不续期、不重试，
失败只清理本次 endpoint。已转发的应用 4xx/5xx 仍视为传输可达。确定性测试覆盖
进程存活但链路失败、本地访问不受影响、显式恢复、并发检查、取消和替换后的迟到结果；
26 项生命周期/service/往返测试和 CLI 类型检查通过。

loopback 探测与转发现共用 `preview-target-transport.ts`，绑定选定 literal 地址并
保留已授权 Host/TLS 身份。每个 endpoint 拥有直接连接的 Undici pool 与 WS lookup，
全局代理配置不能改变目标流量去向。真实本地 HTTP/WS 测试覆盖 IPv4-only、IPv6-only
localhost 服务和拒绝网络请求的全局 dispatcher；关闭同时释放连接池及 socket。
7 项 surface 测试现覆盖精确 Quick origin 与 iframe 来源检查，包括恢复后拒绝旧 origin。

就绪失败保留 cause 与最后一条脱敏 connector 错误。此前原生冒烟曾在 20 秒公网
期限失败，报告内部 DNS resolver 超时；独立 DNS/SRV 与 TCP 7844 检查成功。
通过已配置 CONNECT 代理请求 Quick 域名时也出现 TLS 失败。这些证据不能确定唯一
根因，且没有修改用户网络设置。
后续隔离合成服务探测注册了 1 条 QUIC 边缘连接，但 curl 请求在五秒内超时，
没有 HTTP 请求到达 fixture；子进程已按测试期限退出。这次边缘注册不证明公网
HTTP/WS 就绪。loopback 与 Annotation 改动后的仓库级检查通过，文档检查无错误。

后续真实公网冒烟已使用生产 QuickTunnelSession 通过 HTTP/query 转发、匿名 403、
二进制 WS/子协议、健康检查、撤销关闭 WS 及本地服务继续可用的测试。该测试显式
下载固定的官方上游制品，不是尚未发布的产品 runtime channel；所拥有的测试资源
已清理。单次样本证明所测网络下传输可用，不证明跨地区稳定性、性能或完整客户端 E2E。

独立的公网浏览器 fixture 现把生产 session/frame 与临时 Vite 合成项目连接，
不改变纯 loopback 测试的边界。制品与 TLS key 位于项目文件允许范围外；显式提供
本地制品时仍使用生产完整性/安装校验。它尚未通过浏览器断言：五次尝试停在未改动
的 20 秒就绪检查，一次通过就绪后暴露 fixture 的代理绕过问题。Playwright 会在
用户规则后追加 `<-loopback>`；将它放在最前面，后续显式 loopback 排除规则才生效。
修复后独立 HTTPS 检查在直连/代理模式均通过，但公网重跑再次未就绪，不能据此
宣称真实 iframe/HMR 验收通过。测试拥有的资源已清理，没有改动产品超时或网络配置。

真实 HTTP 测试还覆盖 gzip/br HTML/JSON 解码、注入后长度、HEAD/304 无 body、
二进制上传限制。流式超限回归暴露上游泄漏：只释放 reader lock 并不会取消未结束的
响应。失败路径现先取消 body 再释放锁。测试在 viewer 收到首块后显式发送超限数据，
等待 viewer 失败与 origin 关闭，不使用 sleep；修复前失败、修复后通过。全部 78 项
Preview 测试及 CLI 类型检查通过。修复后的整仓检查也已通过，其中 CLI 测试
2,864 项通过、4 项跳过。

原生进程归属测试发现缺口：父进程 SIGKILL 后，固定版本 macOS ARM64 cloudflared
被 PID 1 接管，metrics 仍返回 200。隔离测试的子进程随后已结束。现有 Supervisor
终止的是 Worker，不是该孙进程。已采用并实现每个隧道一个轻量 IPC 生命周期
子进程，持有原生进程与临时配置。正常 IPC stop 保留清理错误返回通道；父 IPC
断开也触发清理，不轮询、不自动重启、不管理开发服务器。三种 CLI 构建均输出
独立 worker 入口。代价是每个活跃隧道多一个 Node 进程，避免共享 watchdog、注册表与跨 Session
清理策略。真实 POSIX 进程测试覆盖创建中/已连接时强杀 CLI、正常关闭、
原生崩溃、制品缺失和清理失败。重新校验官方制品后，macOS ARM64 2026.9.1
使用生产 worker 复验：创建阶段父进程 SIGKILL 后原生进程与 owner 均退出，
配置删除，独立本地 HTTP 服务仍可访问。该结果不证明其他平台，也不保证
生命周期子进程自身被强制结束后的回收。
当前 87 项 Preview 测试还覆盖创建取消以及 Node owner 的 Electron 标记保留与
敏感环境隔离。公开/Cloud 生产构建在 2 GB heap 限制下通过；开发构建及对应的
原生归属复验也通过。不据此宣称打包 Electron 或其他操作系统的运行时验收完成。
生命周期变更后的整仓及文档检查通过；最后新增的环境隔离测试也由聚焦的 87 项
Preview 测试覆盖。

分发现在通过静态 JSON import 将收集的上游/依赖声明随 CLI 打包，安装时与
cloudflared 一起原子写入完整文本。缓存复用校验该文本；缓存缺失文件或随包声明的
版本不匹配直接报错，不静默修复，也不增加另一套资源复制流程。生成器确定性合并
五种平台选择及 Go runtime/vendor 声明。跨平台核查纠正了此前单一 Go 版本的假设：
Darwin 使用 Go 1.26.2，Linux/Windows 使用 1.26.8，且 Windows 开启 CGO。生成器
现接收所有 Go 源码目录，拒绝冲突副本，合并 100 个声明文件；Windows 已按开启
CGO 重新收集。5 项生成器测试和 8 项安装/缓存测试通过。五个独立制品的校验和、
模块版本/校验和/替换依赖均匹配固定 manifest 与源码依赖图，各编译模块都能找到
匹配源码字节的许可文本，包括替换 fork。所有主模块构建 revision 都为 dirty 且与
源码 tag 不同；依赖一致不证明完整构建来源。原生链接与非 Go 源码仍需发布前审查。
见[分发维护](../../../../apps/cli/src/preview/README.md)。
隔离安装使用五个已验证官方制品覆盖全部六个平台 manifest 条目：二进制与完成记录
的校验和一致，100 段声明逐字匹配，缓存复用不下载；测试安装目录已清理。这是在
macOS 上测试跨平台安装，不代表其他平台原生执行。包含全部 100 段声明的 CLI
production 构建在 2 GB 堆限制下通过，包括发布 bundle import 检查；70 项 Preview
测试及 5 项生成器测试通过。多工具链修正后已重新运行仓库级检查并通过，文档检查
无错误。

仅监听 loopback 的 HTTPS/CONNECT fixture 现使用真实 proxy 与生产 frame factory，
在 Chromium 145.0.7632.6 和托管 CSP/credentialless COEP 下运行。页面、资源/API、
文本与二进制 WS/子协议、分区 Secure/HttpOnly Cookie 保存、无 token 深层导航、
匿名 HTTP/WS 拒绝、凭据清洗及撤销后本地访问均通过。完成以浏览器/socket 事件为准，
不用 sleep。真实 Vite 7.3.1 模块 HMR 也已通过且 document 不重载：只注入文件
变更事件，client、模块图及 WS/模块请求均使用实际实现。fixture 根目录用 realpath
规范化，避免 macOS 临时目录符号链接影响模块解析。React 19.2.0 搭配现有 SWC
插件的 Fast Refresh 也通过，组件状态、document 和 query 均保留。匿名观看者
可用完整 Share URL 访问和操作，再去掉 URL 中的初始凭据并通过自己的 Cookie
刷新页面。可选的独立依赖 fixture 也通过 Vue 3.5.43 模板 HMR/状态保留，以及
Next 16.3.5 Webpack/Turbopack 的服务端 query 渲染、交互、Fast Refresh/状态保留和深层
页面刷新。Vite 注入文件事件；Next 用实际 watcher，以 DOM/HMR 信号完成而非 sleep。
Next Suspense 的可控数据 gate 还确认原始响应与代理客户端 RSC 导航都能在数据完成
前提供 shell/fallback，随后显示最终内容。代理首次 HTML 在有限 SSR 完成后能正确
渲染，但 HTML 注入路径等待 EOF，不保留初始 HTML 的渐进式首屏；本机 Managed
Preview 也有该限制，直接打开原服务不受影响。测 Next Link 前必须等待 hydration，
过早点击会触发普通文档导航而不是 RSC。以上不等于 Cloudflare 实网流式
响应、完整 Browser UI 或原生客户端 E2E。

Next 最初拒绝未转换的外部 Origin。配置开发域名 allowlist 证实了原因，但不是
最终修复，因为临时 Quick 地址变化后还需重新配置。共享 HTTP/WS 转发现在仅把
精确绑定的 viewer Origin 映射回已授权本地 Origin，与 Host/Referer 一致。
第三方、opaque 和缺失 Origin 原样保留；真实上游 HTTP/WS 拒绝测试覆盖其他 Quick
域名及后缀伪装。Next 随后无需 allowlist 配置即可通过。capability 鉴权仍先于
转发执行，不以 Origin 作为访问授权。
Mobile 前端与 Electron production-mode bundle
也已编译通过；Electron 使用合成部署地址，不算后端联调。

## 消融清理（2026-09-23）

基线通过 87 项 Preview 测试。保留的每项简化均单独应用并重跑整个 Preview 测试集，
未增加生产回退逻辑。

| 消融项 | 证据与结论 |
| --- | --- |
| 删除两套手写 header 聚合函数 | 保留删除：Fetch `Headers` 已合并重复名称；代理仍剥离应用 Cookie，且只输出一枚 capability Cookie。重复 header/Cookie 边界断言通过；这不是任意原始 header 列表的通用转换器。 |
| 删除纯内存槽位的异步包装、未使用时间参数和返回 key | 保留删除：预留与释放仍同步修改状态。新增跨工作区测试证明机器级上限，以及撤销、下载失败后的槽位复用。 |
| 删除手工初始化及空操作 Promise resolver 字段 | 拒绝删除并恢复：88 项单测通过，但 CLI 构建/类型检查报 TS2550，因为当前配置的类型库不包含 `Promise.withResolvers`。不为这次清理扩大到全局编译配置变更。 |
| 删除进行中的健康检查合并 | 拒绝删除并恢复：并发健康测试发起了重复探测，端点变成 inactive，而不是保持 active。 |

恢复两项被拒绝的消融后，88 项 Preview 测试全部通过。多 owner fixture 也改为关闭自身的
child promise，而非最后创建的 child。这些结果只证明本地回归边界，不证明实网性能，
也未增加 Windows 或打包 Electron 的验收证据。

## 测试清理（2026-09-23）

测试清理以行为边界而非行数配额为准：header/注入 helper 的重复检查交给真实
HTTP/WS 覆盖，重复的 RPC/UI 成功路径搭建并入生命周期转换，删除纯文案断言。
鉴权、origin/source 校验、进程清理、延迟定时器到期及分段日志解析仍保留；
独立审阅否决了将后两项当作重复测试删除。各展示状态的 story 保持可用。
此次只精简测试，不改变产品行为，也不增加实网验收结论。

## Storybook 状态覆盖（2026-09-23）

浏览器展示统一由 `SessionBrowserPanelView` 负责，生产控制器与 38 个状态 story
共同使用；另有 12 个控制器 story 通过合成 RPC 数据执行真实导航处理函数。
这样既不复制产品 UI，也不依赖真实隧道完成视觉审阅。提取不改变控制器状态、
授权与端点生命周期。地址栏下方的两条常驻横条已移除：一个紧凑状态控件以不同
图标和可访问名称区分本地直连、已连接、创建/检查中、过期/关闭与失败/不可用，
点击后显示本地/远端关系、诊断信息、必要事实以及适用的恢复/停止分享操作。覆盖
本地/远端分享、创建/查询、各类有区别的关闭/失败展示、恢复及其不可用原因、
popover 打开状态、页面加载、标注工具栏状态、历史导航、诊断信息、公共浏览器
不可用、窄屏、深色与中文。

已连接状态由真实 Managed Preview surface 显示不执行脚本的 HTML fixture。
这验证展示，不验证远端凭据、Electron 原生网页、标注消息或 Cloudflare 连通性。
原有 31 项控制器/surface 测试通过。50 个 story 全部通过浏览器巡检，逐一截图并
检查执行完成、浏览器错误、打开的 popover 与恢复按钮；popover play helper 用真实
Enter 键激活地址栏状态控件，控制器 story 另行验证地址栏真实键盘 Enter。静态
Storybook 构建在 8 GB Node 堆限制下通过（4 GB 内存不足）。
为支持嵌套 pnpm 安装，Storybook 开发服务
明确允许两个解析后的字体包目录，不把私有仓库加入文件系统允许列表。

部署后的控制联调、制品发布、真实 iframe/WS 凭据、实网健康行为与全面验收仍需完成。完整契约落实并有证据之前，本记录维持 proposed。
