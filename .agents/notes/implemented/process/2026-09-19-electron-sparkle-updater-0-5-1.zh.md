# 升级 electron-sparkle-updater 到 0.5.1

Status: implemented
Date: 2026-09-19
Translation: current
[English](2026-09-19-electron-sparkle-updater-0-5-1.md)

## 摘要

桌面端的 Sparkle 桥接一直钉在 0.3.0，而上游已经发布了 delta 增量链更新、逐段增量签名校验、
`installUpdateOnQuit` 桥接 API，以及一个 `init()` 修复——清除弃用的 `setFeedURL:` 持久化到
user defaults 的 feed URL。本次把版本钉到 0.5.1，并在 `minimumReleaseAgeExclude` 里为该版本
加了豁免，因为它发布不足七天隔离期。除了删掉一个已无实际作用的 `publicEdKey` 占位参数外，
应用代码无需改动；打包路径、原生桥接重建流程和事件契约均未变化。

## 证据

- 0.3.0 → 0.5.1 API 差异：`loadSparkleBridge`、`init`、`checkForUpdates`、
  `installUpdateNow`、`setAutomaticChecks`、`setEventHandler` 签名保持不变。
  `SparkleInitOptions.publicEdKey` 变为可选且仅作提示——当传入 key 但 Info.plist 没有
  `SUPublicEDKey` 时桥接只打警告；打包产物总会在 afterPack 注入真实 key，因此
  `AppUpdaterService` 现在仅在 `SPARKLE_ED_PUBLIC_KEY` 环境变量存在时传参。
- 包结构变化：npm tarball 携带 `native/sparkle-chain.tar.xz`，即打了 delta 链补丁的
  预编译 universal Sparkle 2.9.4 framework。补丁哈希匹配时 `fetch-sparkle.sh` 直接解到
  `native/vendor/`，所以 `electron-builder.yml`（`native/vendor/Sparkle.framework`、
  `native/build/Release/*.node`）与 `resolveSparkleAddonPath` 的约定依然成立。发布 CI
  不再需要下载 Sparkle 源码或用 Xcode 构建 framework；node-gyp 仍负责编译桥接。
- 0.5.1 的 `clearFeedURLFromUserDefaults` 修复对本应用是防御性的：0.3.0 本来就只在
  Info.plist 缺少 `SUFeedURL` 时才调用 `setFeedURL:`，而打包产物始终带这个 key。
- `download-progress` 事件为 delta 链新增了 `phase: 'apply'` 与 `fallback` 字段；
  `sparkleEventToStatePatch` 仍统一映射为 `downloading`，行为正确但渲染端无法区分
  "应用中"阶段。
- 增量更新需要服务端 feed 生成配合（`generate_appcast` + BinaryDelta 历史）。本次升级后
  客户端已具备 delta 能力；发布管线在本仓库之外。

## 取舍

- `minimumReleaseAgeExclude` 条目是经请求者确认的、针对单一版本的隔离豁免；七天延迟
  对其他依赖依旧生效。
- `installUpdateOnQuit()` 暂未使用；`quitAndInstall` 保持立即重启安装的语义。

## 验证

- 对三个 Sparkle 测试套件（`app-updater-sparkle-policy`、`app-updater-sparkle-events`、
  `sparkle-packaging`）运行 `node --test` —— 24 个测试通过。
- Electron node 工程 `tsgo` 类型检查通过。
- `pnpm exec electron-sparkle-updater rebuild --arch arm64` 在 Electron 39.5.1 上产出
  `native/build/Release/sparkle_bridge.node`，正确链接到 vendor 里的 universal framework。
- 未重跑打包端到端验证（`verify:sparkle-update`）；它覆盖的是同一套 rebuild + plist +
  appcast 路径。
- `pnpm run docs check` 因本地 submodule checkout 导致 `specs/usage-delivery*.md` 存在
  既有的坏链而失败，与本次改动无关。
