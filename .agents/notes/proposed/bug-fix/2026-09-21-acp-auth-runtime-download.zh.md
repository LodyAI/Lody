# 让 ACP 登录路径的运行时下载可见且可取消

Status: proposed
Translation: current

[English](2026-09-21-acp-auth-runtime-download.md)

## 摘要

一次失败的 Codex 登录之后可能紧接着冒出"需要重新下载 acp-codex 托管运行时"的报错
（LodyAI/Lody#828，Bug 2）。登录路径解析托管运行时时不传 abort signal 也不传进度回调，
下载不可见地进行，取消按钮和认证超时都打断不了它，下载失败还会被当作登录错误返回。现在
登录路径会转发取消信号，并通过新的 `runtime-download` 进度事件把下载进度渲染到登录面板。
同一调查中发现的第二个缺陷——缓存 metadata 与钉住的定义不一致时，所有状态检查和重装都硬
报错——在本 PR 评审期间已由上游 #906 修复，因此本次改动放弃了与之重叠的缓存修复，只保留
登录路径这一半。

## 问题发现

桌面端内置登录直接 spawn 托管的 provider 二进制：
`AcpAuthenticationManager.authenticate` → `resolveBuiltinAuthenticationProcessLaunch({ action: 'login' })`
→ `resolveManagedRuntimeForLaunch` → `ManagedAgentRuntimeManager.resolveRuntimeForLaunch`，
运行时尚未安装时会当场下载。

- 登录调用既不传 `signal` 也不传 `onManagedRuntimeProgress`，而状态探测路径
  （`probeBuiltinAuthentication`）两者都传。下载期间登录界面没有任何提示，取消和超时只有
  在下载结束后才生效，因为中断检查排在 launch 解析之后。
- 该解析阶段的任何失败（包括下载错误）都会被 `authenticate()` 的 catch 当作登录错误返回，
  于是运行时问题被呈现为登录失败。
- 另外一个独立缺陷：缓存的 `metadata.json` 与钉住的定义不严格相等（同版本 re-pin）时，
  `readCurrentInstallation` 直接抛出，状态、启动、重试全部死路，只能手动删除缓存目录。
  上游 #906 已先行修复这一半：pin 不匹配的条目按未安装处理并重装；启动时的缓存整理容忍
  单运行时失败；无法解析的 metadata 在启动/安装路径上仍按设计硬报错。本 PR 维持该设计，
  不再重复讨论。

## 决策

- 登录路径的 launch 解析（`apps/cli/src/agent/acp-authentication.ts`）传入
  `running.abortController.signal` 和一个 `onManagedRuntimeProgress` 回调，把下载进度以新的
  `AcpAuthenticationProgressEvent` 变体 `runtime-download`（`runtimeName`、`runtimePhase`、
  可选 `runtimePercent`）转发出去。该事件经 `machine/acp-authentication-progress` 上线路；
  schema（`message-schemas.ts`）、手写接口（`message.ts`）以及 local-session-control 的
  两个校验器（`.ts` + `.cjs` 镜像）同步扩展。登录面板在 `phase === 'running'` 时渲染一行
  i18n 状态文案，并在 `starting`、`complete`、取消和出错时清除。取消复用管理器的消费者
  租约语义：中止登录只释放该消费者，并发的设置页安装会让共享下载继续存活。
- `AcpAuthenticationManagerOptions` 新增 `resolveAuthenticationProcessLaunch` 注入点（与既
  有的 `spawnProcess`/`resolveLoginShellEnv` 注入一致），测试借此观察 signal/进度接线，无
  需真实下载。

考虑过的替代方案：

- 登录路径拒绝下载（要求先在设置页下载）：更安全，但改变了首次使用的体验；现在登录即下
  载变得可见且可取消。
- 把缓存降级扩展到无法解析的 metadata 和复用扫描：在 #906 之后放弃——写了一半的 metadata
  本来就不可见（`.lody-complete` 标记在 metadata 之后写入），且上游有意让启动/安装路径对
  损坏缓存保持显式报错。

## 证据

- `apps/cli/src/agent/acp-authentication.test.ts`：新增测试断言登录路径转发
  `AbortSignal`、把进度以 `runtime-download` 转发，以及 launch 解析期间取消会以
  `cancelled` 收尾且不 spawn 进程。在原始基线上进度测试失败、取消测试挂到超时。
- `packages/shared/tests/message-schemas.test.ts` 与 `local-session-control.test.ts`
  接受新消息形态，并拒绝缺少 `runtimeName`/`runtimePhase` 的 `runtime-download` 负载
  （TS + CJS）。

## 验证

- `vitest run src/agent/managed-agent-runtime.test.ts src/agent/acp-authentication.test.ts`
  （apps/cli）：除两个 `probeBuiltinAuthentication` 失败外全部通过——这两个失败在本机原始
  基线上同样复现（本机 Node 26；仓库支持 Node 22.14–22.x / 23.6+），与本改动无关。
- `vitest run tests/message-schemas.test.ts tests/local-session-control.test.ts`
  （packages/shared）：全部通过。
- 根目录 `pnpm typecheck`、`pnpm lint`、`pnpm lint:i18n`、`pnpm format` 与三项边界检查通过。
  `packages/components` 套件在本机因已知的 `localStorage`/jotai 环境问题失败，在原始基线上
  表现相同。

剩余限制：登录期间下载本身失败时，登录错误仍是运行时安装报错——现在有可见的进度先行，信
息是准确的，但还不是单独的"下载失败"措辞。状态探测路径原本就有 signal/进度，未改动。
