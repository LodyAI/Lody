# Streams token 原生共享刷新所有权

Status: implemented
Translation: current

[English](2026-10-12-effect-streams-token-provider.md)

## 摘要

Streams token 刷新原先用 provider 内的 Promise 围住结果发布，却无法取消并等待真实刷新工作。
现在单一 Effect 4.0.2 内核拥有凭据准入、共享刷新租约和加密缓存发布，Promise 调用方只通过显式
Legacy 门面执行。一个等待者取消不影响其他消费者；替换和关闭等待真实 I/O，失败时保留拥有者
及完整 Cause。Renderer、durable 外层编排和 daemon 全局关停不属于本单元的完成范围。

## 合同与决定

本单元部分替换[旧刷新决定](../bug-fix/2026-09-13-streams-token-refresh.zh.md)的实现机制，
保留 endpoint/workspace 隔离、内存命中前解析当前凭据、401/403 terminal 抑制、上次返回 token
回退及 rejected-token 单槽。拒绝到达已发出的刷新时，最多额外请求一次，所有等待者共享这次请求。
WebCrypto 完成后在存储写入前同步检查凭据与拒绝标记。Schema、编解码和 CRDT 仍是普通函数。
[已有 Spec](../../../../specs/streams-token-refresh.zh.md)保持 draft；不新增 Spec、协议、服务端或部署。

五项生命周期合同：

- 触发：读取先解析当前凭据，再命中缓存或借用 provider 内的刷新。拒绝只使匹配的已服务 token 失效。
- 拥有者：provider Scope 持有准入/读取 fiber 和显式 producer 子 Scope；调用者持有等待者与租约。
  真实 fetch/body、登记的 Legacy 凭据边界和 WebCrypto 保留实际结束回执。
- 取消：等待者超时/取消只退休自己的读取；最后租约释放 abort 并等待 producer。
  凭据替换/关闭必须确认清理后才替换拥有者槽。独立准入快照按解析次序设 fence，结束前各自保留拥有者。
- 交接：发布前同步检查 generation、credential、rejection；关闭共享 Deferred 回执。
  失败关闭保留同一失败与子 Scope；显式 retryCleanup 等待真实资源结束后才重新准入。
- 失败/恢复：auth、HTTP/credential/response、deadline、取消保持区别；原生 getToken/auth 保留 typed auth failure；
  仅显式 Legacy 旧协议 callback 将非空全 auth Cause 投影为 undefined。释放 defect 保留 raw owner；关停 defect 保留 provider 与完整 Cause，
  包括 timeout/interruption 和释放失败同时发生的情形。

拒绝外层 tryPromise(getToken)，因为它会保留旧 Lody Promise 编排。考虑过 RcMap/FiberMap，
但它们在锁定 v4 中不能证明等待旧资源替换或保留释放失败；有限 provider 采用 Semaphore、Scope、
Fiber、Deferred。Scope.make 刻意保留子 Scope 直到显式成功关闭，避免有界释放失败后附着的自动
Scope.close 再次无限等待。

锁定源码证据：effect@4.0.2 的 internal/effect.ts 中 raceAllFirst 使用胜者 Exit，等待中断败者
时不投影败者的清理失败。因此 deadline 放在读取 fiber 的观察者上，随后由独立拥有者中断并检查
完整 Exit。Raw join 只竞争可中断的结束观察者和 Clock sleep；到期后 raw 工作仍在 I/O registry。
第二次 Scope.close 不共享第一次 finalizer 完成结果，因此 provider 有自己的回执。

## 消费者与边界

原生 API 是 LoroStreamsTokens / LoroStreamsTokensLive、makeLoroStreamsTokenProvider 和
每个 provider 独占的 LoroStreamsTokenPorts。官方 CLI 组合的 native token port 要求 Scope，
提供原生凭据和带 signal 的 getCliHttpFetch。构建仅登记所有权，不初始化 credential/cache/HTTP，
因此 acquisition typed error 为 never；首次读取错误归 getToken，已获得 provider 保留所有权。
Service/Layer/factory 组合相同内核与 cache。本地 port 仍不提供 cloud token 能力，telemetry 仍关闭。

剩余消费者为 renderer workspace/eager-sync auth、CLI durable streams-access/streams-transport
及 Machine RPC。它们使用唯一 createLoroStreamsTokenProviderLegacy，以及显式平台
createTokenProviderLegacy port/type。删除旧无 Legacy 名 factory 和 Promise port 入口。
Renderer 拆除在丢弃 provider 前等待 close；官方 CLI root 在 dispose 前保留 Legacy provider，
失败实例保留供恢复。Runtime 与 provider 的 abort signal 合并，不再相互覆盖。

待这些调用方及应用拥有者组合原生 Effect 后，删除 Legacy 门面、兼容凭据适配和 provider registry。
使用本内核不代表上层或 daemon 端到端所有权原生化。根路线图由协调者单独维护。

Auth context 保持结构化 `{ reason: string; previousToken?: string }`。只有 unauthorized
拒绝 JWT；显式 previousToken 优先，否则长期 callback 记住自己最后成功返回的 token。
Direct getToken 没有 callback fallback。旧 token 的晚到 callback 不抹去新缓存；等待者共享必要的
一次额外 request。

原生 health 与 describeLoroStreamsTokenCause 只提供生命周期、generation、计数、presence flags、
排序失败类别和 401/403 状态，不含 token、凭据、URL、原始 message/stack、Cause 或 owner。
嵌套 retained Cause 迭代遍历并按对象身份去重；恢复仍保留原始完整 Cause。关闭/超时清理失败后
health 仍可观察，成功 retryCleanup 清除阻塞。同一 parent Scope 的后继 provider 使用独立 close
receipt。Retained release failure 在新 credential I/O 准入前设置 fence，而非只阻止 producer
替换。不修改 P1 拥有的 logger/presence 文件。

Raw HTTP receipt 包括 success-body EOF 与 error-body 取消；body 释放拒绝保留 owner 和
I/O failure，401/403 同时保留 typed auth 原因与 terminal suppression。Cleanup 报告已经结束
但释放失败的 receipt 后才退休它，下一次成功 retry 才允许交接。锁定 v4 tapCause 使用
andThen(f(cause), failCause(cause))，观察器失败会替换原始错误，因此同步 event hook 显式
取得 Exit 并 Cause.combine；通过真实 Legacy 门面的 auth + observer 失败验证。

## 证据与限制

PR：[#1506](https://github.com/LodyAI/Lody/pull/1506)（draft）。
已验证源码 revision：32c5d29dcfdaf9330c36355d285d43e4e74906f9；后续仅文档提交记录该 revision。

Base：3ac76bad10f46720517a2ca6929f03de4ef5bb9b。Effect 保持 4.0.2，无 manifest、lockfile
或 submodule gitlink 改动。已有 token suite 使用 HTTP/encryption/admission 显式 signals，原生
时限由 TestClock 驱动，保留真实 WebCrypto/加密缓存回归。两项允许旧 raw 未清理便开始新工作的
旧测试改为验证真实交接；按凭据回调次数制造的竞态替换为显式加密 fence。
删除仅 mock 次数断言；并发 callback 等待真实准入信号后才释放 HTTP，不依赖 Promise 调度顺序。

验证：已有 shared auth suite 53 项通过；五个 CLI token/local-only/document suite
44 项通过；renderer runtime/eager/meta 和 cloud-policy suite 111 项通过。
最终 pnpm check 的 typecheck、lint 通过；CLI 16 项失败、4025 项通过、1 项跳过。
其中 15 项持久失败来自未修改的子进程 suite：
baguette-process、guest-buttons、host-controls、github-git-transport、cloudflared-process，
独立 base SHA checkout 配合同锁定依赖和同 SHA ACP 产物，
用 pnpm --dir apps/cli exec vitest run 指定这五个文件并设 --testTimeout=5000 限制诊断，
复现相同 15 项失败，包括继承 Git shim 的 context_unreadable、simulator fixture 不可用、
cloudflared exit/cleanup 超时。属于基线/环境失败，不是 token 改动回归。额外 roost goal-cache 测试在全仓运行中超过 30 秒，
其完整 30 项 suite 在当前源码与 base checkout 单独运行均通过；较早一次全仓运行的未修改
daemon fixture import hook 也超时，base 独立 suite 16 项通过。保留这些依赖时限的原 suite，
未扩大修复范围。递归测试后的 Electron suite 未执行。shared suite 新增 lazy acquisition/typed credential failure、原生 terminal/混合 Cause、
安全诊断、显式/回调 fallback 拒绝语义、retained health/恢复及同 Scope 后继清理；source 中
明确约束 acquisition error 为 never。

pnpm format、pnpm format:check、对 changed shared/docs 显式根 Oxfmt、pnpm run docs status、
pnpm run docs check、i18n、Code Collab、platform、CLI process 和 public-boundary guard
通过。初始依赖/submodule 和受限 worker 问题在本单元 clone 内解决；未修改全局 Git 配置，
仅验证子进程过滤继承的 GIT_CONFIG_*。

独占临时 overlay 中 baseline/restored auth suite 通过；分别移除共享 lease 保护、raw settlement
join、rejected-token storage fence、late unauthorized matching、加密后 credential fence、
完整 raw-owner Cause 聚合，均使对应行为回归失败；增补还消融 native auth 失败保留、Legacy all-auth 投影、诊断脱敏、credential 准入、
observer Cause 合并、success/error-body 等待与 release-owner 登记，共 14 项。消融脚本和日志不进入产品/仓库。
未验证真实 cloud/issuer、生产服务、npm 发布、已安装桌面、Windows/macOS 打包，或整个
Session/Turn/durable 生命周期。
