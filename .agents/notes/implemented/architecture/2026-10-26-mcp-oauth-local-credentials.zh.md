# MCP 授权凭证的本机所有权

Status: implemented
Translation: current

[English](2026-10-26-mcp-oauth-local-credentials.md)

## 摘要

MCP 服务器定义仍属于工作区并参与同步，OAuth 和手动凭证仅保存在执行账户的本机系统凭证库。
原生后台服务通过 MCP SDK 接通设置、发现和选中的 Agent 调用，HTTP Agent 获得受限的本机连接，
不会拿到上游 token。模拟授权与取消测试已通过；Slim Tools 真实账户授权和各系统凭证库验收仍未完成。

## 边界与兼容

名称、传输类型、无凭证地址和完整 `${VAR}` 引用仍可共享。`authentication: 'local'` 描述服务
要求，不是机器绑定或共享登录状态。OAuth token、refresh token、客户端注册、client secret 和
手动填写的 token、请求头、环境变量值都在本机。任意字面量请求头及环境变量值均按私有值处理，
不猜测哪些字段名包含秘密。记录绑定机器、工作区、本机账户、条目和环境变量展开后的实际连接，SDK 的 issuer 与
客户端标记保持授权服务绑定；目标变化后旧凭证不再适用。本机 RPC 核对界面与后台账户，缺少账户的旧版探测不读取凭证库。其他机器独立授权，其他请求者拿不到
机器所有者的凭证或后台环境变量。E2EE 分享还需单独约定接收者、同意和轮换，本次不启用。

[共享序列化](../../../../packages/shared/src/mcp-authentication.ts) 在界面和后台写入边界拒绝新
字面量凭证。读取旧配置时剥离这些值及含凭证的 URL 部分，不导入其他人的凭证库。归一化不能
删除原始 CRDT 历史，也不能让已共享的凭证重新私有。任意命令参数或 URL 路径中的秘密无法
可靠识别，认证值必须使用专用字段或环境变量引用。

## 运行时与交互

[原生服务](../../../../apps/cli/src/mcp/authentication/service.ts) 拥有授权尝试、串行刷新和逐运行
实例的中继 Scope。[I/O 适配器](../../../../apps/cli/src/mcp/authentication/io.ts) 使用锁定的
MCP client SDK 2.0.0；标记弃用的 Promise facade 桥接 SessionManager 和本机 RPC，没有顺带
迁移整个 Session 生命周期。先退出 Session，再关闭授权服务。

只有实际的 401 Bearer challenge 加上校验通过的受保护资源和 issuer 元数据，才能确认标准
OAuth 支持。普通 401、Cloudflare 403 或网络错误不推断为登录。设置复用 MCP 编辑器，增加明确的
“设置”入口和“登录与授权”区域。保存、检测不会打开浏览器。保存配置后，用户明确点击才使用
PKCE S256 和校验 state、仅接受一次授权码的本机回调。网络步骤有时限，授权尝试十分钟到期。
取消会等待回调清理并阻止迟到的回复和授权码；取消替代授权会保留此前的登录。可选客户端字段
支持预注册应用，不承诺兼容任意自定义登录。被否定的授权范围提示行没有保留。

手动秘密与共享表单值拆分，只通过能力门控的本机 Machine RPC 发送，不回退到远程接口。
秘密输入框不读回 token。`@napi-rs/keyring` 使用 Keychain、Credential Manager 或 Linux Secret
Service；凭证库缺失或锁定时报错，不回退明文。匿名服务不要求安全存储后端可用，系统交互仍需
逐平台验收。“退出授权”关闭本机连接并删除本机记录，尚未实现服务方的同意撤销。

HTTP 中继绑定选中的条目、确切运行实例及请求者，Agent 拿到随机本机能力凭证。中继拒绝 Origin
和异主机 Host，Linux 还复用完整 socket 四元组查询验证 peer uid。它保留 GET/SSE，限制请求体
和队列，运行四个 worker，拒绝重定向并隐藏服务方错误响应体。会话退出或退出授权会关闭端点；
迟到的启动不能重建已退出实例的连接。stdio 凭证仅进入选中的进程环境。请求者变化时，带 MCP
的 Session 先退出，防止另一用户复用旧进程。刷新串行执行，新记录落盘后才能复用。浏览器授权码
和 verifier 仅在尝试中存活，界面状态不带 token。

## 证据与限制

模拟测试覆盖真实 SDK 的授权码、PKCE 和刷新，回调 state、重放、拒绝，取消和迟到界面回复，
目标及用户隔离，中继凭证及请求头过滤，本机 RPC 路由，共享写入拒绝和旧值归一化；同时运行
既有发现和 Session 生命周期测试。最终命令与结果见任务报告。测试注入 HTTP、监听器和凭证库，
不访问真实服务方。

此前公开的 [Slim Tools 元数据](https://slim.tools/.well-known/oauth-authorization-server) 声明
支持注册、授权码、刷新及 S256。较晚的 Python initialize 探测收到没有 OAuth challenge 的
Cloudflare 403。本次没有真实账户同意、Slim 认证调用或生产 token 持久化。
[Magpie](https://github.com/yetone/magpie/blob/main/internal/mcpauth/mcpauth.go) 仅作本机保管和
中继参考，不证明所有服务兼容。标准参考：[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)、
[MCP 授权](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)。

独立检出复用现有依赖及未初始化 ACP 子模块的锁定元数据。当前修订缺少要求阅读的
context/local-agent-ownership.md 和 context/message-flow.md，因此以现有作用域契约、身份和
peer uid 代码为可用依据。远程回调管理、系统验收、服务方撤销和凭证分享不在本次实现内。
草稿 PR：[#1938](https://github.com/LodyAI/Lody/pull/1938)。

独立授权视图已在精简 Storybook 包装中渲染，浏览器验证了需要授权、未保存、等待及已授权
状态。复用依赖的检出中，完整共享 Storybook 外壳遇到已有的 Loro WASM 初始化错误；
本次浏览器验证不等同于完整 Electron 冒烟测试。

在最新 main 的 PR 基线上，CLI 授权/发现/配置/选择 40 项、组件 81 项、共享包 46 项测试
通过，共 167 项。共享包类型检查、范围内 lint、`pnpm format`、i18n 和全部八项边界检查
通过。文档检查仍有 6 处 Kimi/Pi 子模块缺失链接，没有新增错误或受保护主题。

已尝试全仓 `pnpm check` 及 CLI/组件类型检查，但复用依赖缺少较新的 E2EE/Streams 包，
Roost/ACP API 也落后于当前代码。加载当前锁定的 ACP 源码后，三个 Session 测试文件仍因
缓存的 Claude SDK 元数据落后于运行时清单，在模块初始化时失败。Effect patch lint 缺少
`@effect/tsgo`，本机 Node 24.14.0 也低于最新 main 的运行时下限。变基前三个包的类型检查
和 157 项相关测试通过；这些结果不代表新的依赖图已经验证。
