# 允许 macOS 子进程加载运行时安装的原生模块

Status: implemented
Translation: current

[English](2026-09-17-dsh-helper-library-validation.md)

## 摘要

签名的 macOS 版本完全无法启动 DeepSeek Harness：它的本地插件树需要 koffi 的原生绑定，而
npx 安装的这份绑定只有 ad-hoc 签名，macOS library validation 拒绝把这种库映射进现在运行
DSH 的、以团队 ID 签名并启用 hardened runtime 的 Lody Helper。宿主只能看到
`ACP connection closed`。现在 macOS 的嵌套二进制改用单独的
`entitlements.mac.inherit.plist` 签名，其中带上
`com.apple.security.cs.disable-library-validation`，顶层应用继续启用 library validation。
这个例外必然比 DSH 本身更宽——任何由 agent 安装的原生模块都需要它——并且会削弱 helper 进程
（包括渲染进程）的 dylib 来源校验，因为 electron-builder 无法按 helper 分别指定 entitlements。

## 原因与决策

[使用 Lody 内置 Node 运行 DSH](2026-09-16-dsh-bundled-node-runtime.zh.md) 让宿主通过
`process.execPath` 启动 DSH，而打包后的桌面端中它就是 Lody Helper。那个决策修好了在用户
Node 上静默退出的问题，但同时把 DSH 挪进了一个以产品团队 ID 签名、并且
`hardenedRuntime: true` 的进程。DSH 的本地插件（`dsh-subprocess-local`、
`dsh-sandbox-local`，以及 `dsh-fs-local` 和 `dsh-session-persistence-jsonl`）会加载
`@koromix/koffi-darwin-arm64`，而 npx 把它装进 Lody 的 npm 缓存时只带 linker/ad-hoc
签名、没有团队 ID。library validation 因此拒绝映射：

```
dlopen(.../@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node, 0x0001):
  code signature ... not valid for use in process:
  mapping process and mapped file (non-platform) have different Team IDs
```

一个 loader entry 失败会让整棵插件树失败，DSH 退出，宿主只剩下 `ACP connection closed`
这个无从下手的表象。在之前的启动方式下同一份绑定能正常加载，但原因并不是用户的 Node 没有
加固：上游的 Node 22.23.1 同样启用 hardened runtime、签名团队为 `HX7739G8FX`，而它自己
就带着 `com.apple.security.cs.disable-library-validation`。任何通用 Node 运行时都必须
带，因为加载第三方原生模块本就是它的职责。改用 Lody 自己的运行时跑 DSH，等于接下了这个要求，
却没有接下满足它的那个 entitlement。

这个例外只应加在嵌套二进制上，所以它是一份新的构建资源，而不是往
`entitlements.mac.plist` 里加一个 key。`app-builder-lib` 会把 `entitlementsInherit`
应用到除应用包自身以外的所有签名路径，而那正是运行内嵌 CLI 及其 agent 的集合；浏览器进程
只加载随包签名的库，因此保持校验。粒度也仅止于此：`entitlementsInherit` 同样覆盖渲染与 GPU
helper，这是本次修复真实的代价。

另外权衡了两个方案。退回用 npx 的 Node 可以完全避开 library validation，而且原先的
`import.meta.main` 问题不会复发，因为 bootstrap 已经显式导入入口并 `await runCli()`；
否决它的理由是会重新引入上一个决策刚消除的"行为随用户 Node 安装而变"。附带一个由 Lody
签名的 `node` 二进制同样被否决：团队 ID 签名加 hardened runtime 在没有同一个 entitlement
时会撞上同一堵墙，等于增加了一份下载和签名面却没有解除约束。

## 验证

在已安装的签名版本（0.95.0，团队 `YTRMX32C99`，hardened runtime）上确认了问题与修复，三组
对照共用同一个 npx 闭包（`@deepseek-ai/dsh` 0.1.5-rc.2）与同一份生成的 profile：

| 运行时 | 结果 |
| --- | --- |
| 系统 Node 22.23.1 | 返回合法的 ACP `initialize`（`acp-extension-dsh` 0.2.0） |
| 随包发布的 Lody Helper | koffi `dlopen` 被拒，插件树失败，进程退出 |
| 同一 Helper 用本记录的 inherit plist 重新签名 | 返回合法 `initialize`，stderr 为空 |

第三组对照复制了应用包，只对其中嵌套的 helper 用已提交的
`entitlements.mac.inherit.plist` 重新签名，未改动已安装的应用。第一组并不是"未加固"的
基线：那个 Node 同样加固、同样有团队签名，并且本身就带
`disable-library-validation`，所以三行数据把 entitlement 隔离成了决定加载成败的唯一变量。

限制：这里没有产出完整的打包、签名并公证的发布件，所以公证是否接受该 entitlement 只是依据
Apple 文档中的例外清单推断，而非在 Lody 的产物上观察到；也没有自动检查守护这份 plist。只验证
了加载期行为，没有跑真实的 agent 回合。Windows 与 Linux 没有对应的 library validation，
不受影响。

## 集成

- [Lody PR #776](https://github.com/LodyAI/Lody/pull/776)
- 承接[使用 Lody 内置 Node 运行 DSH](2026-09-16-dsh-bundled-node-runtime.zh.md)
