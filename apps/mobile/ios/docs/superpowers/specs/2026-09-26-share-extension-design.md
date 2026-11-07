# Share Extension：原生新建会话表单 + inbox 交接

日期：2026-09-26

取代 [2026-09-17 设计](2026-09-17-share-extension-design.md) 与已回退的 #47（`caa0bbd`，回退于 `80fc76f`）。

## 背景与教训

#47 把新建会话表单改成原生并让 App 与扩展共用，方向对，但 App 内页面视觉不过关被回退。原因：现有 RN 页面底层已经是原生组件（`NativePagedList` + `NativeGroupedList` + `NativeComposer`，picker 页也是 `NativeGroupedList`），#47 没复用它们，另起了一个普通 `UICollectionView` + `UIListContentConfiguration.valueCell()`，行样式、分页、分段控件都与现状不同。

#47 的扩展直接调 `backend.lody.ai/api/workspaces/{id}/session-submissions`，上游 Cloud 没有这个接口。

## 决定

| 项         | 选择                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- |
| 表单       | 新建会话表单迁到原生，App 与扩展共用一份                                                          |
| 视觉       | 用现有 `LodyGroupedList` / `LodyPagedList` 的 UIKit 芯拼出来，等价于当前 RN 页面，不重新设计      |
| 发送       | 主 App 发送：扩展写 App Group inbox，主 App drain 进现有 outbox                                   |
| 扩展进程   | 只有 UIKit；不链 Expo、RN、WebView、data-runtime、OneSignal；不联网、不读 Keychain                |
| 唤起主 App | responder chain 调 `UIApplication.open(lody://share)`；失败发本地通知。不上 App Store，无审核约束 |
| 初版目的   | 始终新建会话                                                                                      |

## 非目标

- 分享到已有会话、最近会话选择器
- 扩展内联网、跑 WebView / CRDT / Machine RPC
- 新增 Cloud 接口
- 抓取网页正文（只带 URL / 文本）
- 跨进程 composer 实例接力
- 视觉改版

## 架构

### 1. 列表 UIKit 芯剥离 Expo

`LodyGroupedList` / `LodyPagedList` 拆成：

- 纯 UIKit 芯（`UIView` 子类）：回调代替 `EventDispatcher`，行模型为纯 Swift struct，不持有 `AppContext`
- Expo 包装：保留现类名与 RN props，只做 `@Record` ↔ struct 映射和事件转发

`LodyPageSectionRail`、`LiquidGlassSegmentedControl`、行视图（`LodyProjectRowView` 等）若依赖 Expo，同样剥离。`LodyAppearanceView` 的换肤观察改为不依赖 Expo 的实现，供芯使用。

### 2. 原生新建会话表单

`modules/lody-kit/ios/CreateSession/`：

- `CreateSessionController`：根页 = 分页芯（项目 / Chat）+ 分组芯 + `ChatComposerView`，布局对齐 `src/ui/ComposerSheet.tsx`
- picker（项目、机器、Agent、模型）：push，内容用分组芯，对齐 `ProjectPickerScreen` / `PickerScreen`
- `CreateSessionForm`：context、记住的项目、options、prefs、canSend、组装 `{session, send}`；逻辑从 `CreateSessionScreen.tsx` 与 `createPrefs.ts` 平移，`create:{userId}:{workspaceId}` 的 JSON 形状不变
- 宿主协议：

```swift
protocol CreateSessionHosting: AnyObject {
  func loadOptions(projectId: String?, chat: Bool) async throws -> CreationOptions
  func persistPrefs(_ prefs: CreatePrefs)
  func submit(_ draft: CreateSessionDraft)
}
```

- App：`loadOptions` 走 DataRuntime `sessionCreationOptions`；`persistPrefs` 写 LocalStore 并写 App Group `prefs.json`；`submit` 经 Expo 事件回 RN
- 扩展：`loadOptions` 读快照；`submit` 写 inbox

超过 500 行按 controller / form / pickers 拆文件。#47 的 `CreateSessionForm` 逻辑可参考，`CreateSessionController` 的列表实现不复用。

### 3. App 内

`CreateSessionScreen` 保留 `definePage` / `present` 壳（formSheet、透明头、detents、morph），内容换成 `NativeCreateSession`（`requireNativeView('LodyKit', 'LodyCreateSessionView')`）。`onSubmit` 在 RN 调 `outbox.put`，composer 接力登记进现有 relay，`send-handoff` 语义不变。新增 `initialText` / `initialAttachments` 参数供 drain 兜底预填。

生产路径不再 present `ProjectPickerScreen` / `PickerScreen` / `ModelScreen`；Debug 仍在用的 RN 页面保留。

### 4. Share Extension

`LodyShare`（`app.innei.lody.share`），由 `plugins/withShareExtension.js` + `plugins/share-extension.rb` 在 prebuild 后生成，复用 `push-extension.rb` 的 `lody_extension`。基于 #47 的 ruby helper 修改：

- 去掉 `keychain-access-groups`、`AuthKeychain` / `SessionAttachments` / `GitHubMentions` / `ShareSubmission`
- 按 file reference 编译列表芯、表单、`ChatComposerView` 及其依赖、`LodyStrings`、`LodyTint` 等；`LODY_SHARE_EXTENSION` 屏蔽 App 专属代码
- `Localizable.xcstrings` 加入扩展 resources
- 签名开启，App Group `group.app.innei.lody`

`ShareViewController`：读快照 → `ShareIngest` 收 payload → present `CreateSessionController`。发送：写 inbox → responder chain 打开 `lody://share` → `completeRequest`。打开失败则发本地通知（"点按以发送到 Lody"），仍 `completeRequest`。

### 5. 主 App drain

`src/features/share/ShareCoordinator.tsx`，挂在 `src/app/_layout.tsx` 与 `PushCoordinator` 并列。`+native-intent` 把 `lody://share` 吞掉，不交给 Router。前台与冷启动都 drain；URL 只是唤醒。

每条 inbox，按 `createdAt` 顺序、一次一条：

1. 等本地账号就绪
2. `manifest.userId` 与当前用户不符 → 删除该条
3. workspace 不同 → 切 workspace，等 catalog
4. 原生 `ShareInbox.adopt(id)` 把附件拷进 App `temporaryDirectory`，返回改写后的 `send`
5. 校验 agent / 机器仍在当前 options 中；不在 → present 预填的新建表单，删除该条
6. `getPendingSendStore(userId, workspaceId).put({ session, send })`
7. 把 choice 写回 `CreatePrefs`
8. `requestOpenSession(session)`
9. 删除该条

`outbox.put` 失败：保留该条，toast。

## 数据

根：`group.app.innei.lody/Library/LodyShare/`。所有写入原子替换。不含 token、grant、Keychain 内容。

| 文件                                  | 写入方                | 时机                          | 内容                                                          |
| ------------------------------------- | --------------------- | ----------------------------- | ------------------------------------------------------------- |
| `catalog.json`                        | RN `CatalogProvider`  | catalog / workspace 变化      | userId、workspace、可创建项目（按最近会话排序）、machineNames |
| `options/{chat\|projectId}.json`      | App 内原生表单 / 预取 | `sessionCreationOptions` 成功 | `CreationOptions`                                             |
| `prefs.json`                          | App 内原生表单、drain | 选择变化                      | `CreatePrefs`                                                 |
| `inbox/{id}/manifest.json` + `files/` | 扩展                  | 发送                          | `{ id, userId, workspaceId, session, send, createdAt }`       |

- App 连上后预取 chat + 最近 10 个项目的 options
- 登出删除整个 `LodyShare/`
- `session` / `send` 与 `outbox.put` 同形；session id 发送时新生成，不用缓存里的 `options.sessionId`
- 选中项目无缓存 options 时，manifest 只带 `projectId` / `context`、正文与附件，不带机器 / agent / choice；drain 第 5 步必然走预填表单
- `send.attachments[].uri` 指向 inbox `files/`；drain 时拷进 App temp 再入 outbox，不放宽上传路径

## Ingest

1. URL / 文本 → composer 文本，去重，空行拼接
2. 图 / 视频 / 文件 → 附件，`loadFileRepresentation` 直接落盘，不整图解码；缩略图用 ImageIO 降采样
3. `com.apple.webarchive` 丢弃
4. 上限：合计 16、图 ≤ 8、文件 ≤ 8、文本 ≤ 64 KiB；超出丢弃并提示
5. 无内容：出示空草稿，Send 不可用

`NSExtensionActivationRule`：`SupportsText`、WebURL / Image / File 各 max 8。

## 失败与空态

| 情况                     | 行为                                                 |
| ------------------------ | ---------------------------------------------------- |
| 无快照 / 未登录          | notice + 打开 Lody，Send 不可用                      |
| 选中项目无缓存 options   | 行标"打开 Lody 后加载"，允许发送，drain 时走预填表单 |
| inbox 写失败             | 保留草稿，不打开 Lody                                |
| 打开 Lody 失败           | 本地通知；inbox 保留到下次前台                       |
| drain 账号不符           | 丢弃                                                 |
| drain workspace 不同     | 先切                                                 |
| drain agent / 模型已失效 | 预填表单                                             |
| `outbox.put` 失败        | 保留 inbox，toast                                    |
| 连续分享                 | 按目录排队                                           |

## 验收

全部离线：不登录、无云、无真实机器。仅 English，light / dark。

1. **视觉等价**：改动前在 main 上跑新 `verify:ui` case `create-parity` 存基线（根页项目 / Chat、各 picker、模型页、空态）；原生化后同 case 像素比对，超阈值失败，前后对比图附 PR。
2. **列表回归**：`list`、`home`、`project-picker`、`model-memory`、`send-handoff`、`morph`、`composer`、`outbox` 全过。
3. **原生确定性检查** `modules/lody-kit/verification/share`：ingest 各类型与上限、快照编解码无凭据字段、inbox 读写删与排队、每次新 UUID、drain 后附件位于 App temp、账号栅栏丢弃。
4. **Debug 场景**：嵌同一原生表单，注入假快照与分享 payload；覆盖发送 → inbox → drain → outbox → 进会话，以及 agent 失效 → 预填表单。
5. **系统分享面板**：沿用 #47 的 `share-probe.py`，App 停止、无凭据下检查表单出现、发送写 inbox、Lody 被唤起。本地执行，不作 CI 门槛。

另：`pnpm check`、`pnpm test`、`pnpm bundle`、签名 `pnpm verify:build`。

## 风险

- 剥列表 Expo 会影响所有 grouped / paged 列表；包装类名与 props 不变，回归靠第 2 项
- responder chain 打开宿主 App 非公开途径，未来 iOS 可能失效；本地通知兜底，drain 是真相源
- 快照 options 会过期；drain 校验失败走预填表单，不静默失败
- 扩展内存：只编 UIKit 子集，附件落盘

## 估时

列表芯剥离 1–1.5 天 · 原生表单 + App 内切换 2 天 · 扩展 + 快照 + inbox / drain 1.5 天 · 验收 1 天。合计约 5–6 天。
