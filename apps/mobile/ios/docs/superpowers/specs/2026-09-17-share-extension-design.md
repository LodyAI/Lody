# Share Extension：系统分享进新建会话

日期：2026-09-17

> 已被 [2026-09-26 设计](2026-09-26-share-extension-design.md) 取代。

> 评审后的前置验证：**点击发送立即向 Cloud 提交**是硬要求，且第三方客户端不能修改 Cloud。
> 因此下文「扩展只写 inbox、主 App 消费发送」不再是选定方案，「扩展不跑 WebView」也待重新验证。
> 先用 `Share transport probe`
> 在真实 Share Extension 中复用现有认证、Streams / CRDT 与 Machine RPC，验证主 App 未运行时新建 Chat 并发送纯文本。
> 只有拿到真实机器 ACK、核对首句及扩展内存后，才继续迁移完整表单与附件；以下保留原稿供后续修订，不能作为已通过的实现规格。

## 问题

iOS 没有「分享到 Lody」。Safari 链接、截图、文件只能先打开 App，再走新建会话。初版要在系统分享面板里完成新建会话（项目 / Chat、机器、Agent、模型、composer），发送后关掉面板并打开那个新会话，第一句已经在飞。

最终形态是分享面板里选目的（最近会话或新建）。初版只实现新建；协议和快照给目的留位，UI 不做选择器。

## 目标

- 系统分享面板里就是现在的新建会话 sheet，不是薄手递、也不是打开 App 再填一遍。
- 同一份原生宿主同时服务 App 内新建和 Share Extension。React 只留 Expo 包装。
- 发送后进入该会话；扩展进程不跑 data-runtime，真正 `createSession` + 第一句仍走主 App outbox。

## 非目标

- 分享面板里选已有会话（形态 3）
- 扩展里发回合、WebView、mentions live、GitHub 仓库现场搜索
- 跨进程 composer 实例接力 / throw 动画
- 把 `catalog.sqlite` 整库搬进 App Group
- 抓取网页正文（只带 URL / 标题）
- Action Extension、Safari View Controller、Android
- 把其它 RN 页面改成原生（只动新建会话这条）

## 决定

| 项            | 选择                                                                 |
| ------------- | -------------------------------------------------------------------- |
| 初版目的      | 始终新建会话（`destination: "new"`）                                 |
| 发送后        | 关掉分享面板，打开刚建的会话，第一句已在 outbox                      |
| UI / 表单逻辑 | 原生 `LodyCreateSessionController`；RN 只包一层                      |
| 扩展进程      | UIKit 子集，不链 Expo、WebView、OneSignal                            |
| 列表          | 先把 `LodyGroupedList` / `LodyPagedList` 的 UIKit 芯从 ExpoView 剥开 |
| 数据          | App Group 只读快照 + inbox；不搬整份 SQLite                          |
| 创建 ID       | 发送时客户端新 UUID（与现 `creationOptions.sessionId` 一样）         |
| 唤醒          | `lody://share/{inboxId}`，前台 drain inbox 才是真相源                |
| 附件上限      | 与上传一致：合计 16，图 ≤ 8，文件 ≤ 8                                |
| App 内发送    | 仍做同一套 composer 接力                                             |
| 扩展发送      | 无接力；进会话时消息已在 transcript / outbox                         |

## 架构

两个进程，一份宿主。

主 App：Expo + 完整 LodyKit + data-runtime。`present(CreateSessionScreen)` 的 form sheet 壳保留（标题、detents 0.62/1、grabber）。页内容是 Expo 包装，embed `LodyCreateSessionController`。

Share Extension：`app.innei.lody.share`，与 NSE / Live Activity 一样由 `push-extension.rb` 在 prebuild 后的 `ios/` 里生成。只编译 UIKit 白名单（file reference，不 copy）。`ShareViewController` 收系统 payload，present 同一个控制器。

扩展链不上现在的 `LodyKit` pod（ExpoModulesCore、OneSignal、MarkdownView）。`ChatComposerView` 已是纯 UIKit；list 必须先剥 Expo。

跨进程没有同一套 `ChatComposerView` 实例，扩展路径不做 `send-handoff` 那种接力。

## 组件

### UIKit 芯（App pod 与扩展都编）

把 list 的 UIKit 从 `ExpoView` 拆开。RN 的 `View(LodyGroupedList.self)` / `View(LodyPagedList.self)` 类名和 props 不变。

- 列表芯：`UIView` 子类，回调代替 `EventDispatcher`，不持有 `AppContext`
- 分页芯：同样，内部仍用 `LodyPageSectionRail`（已是纯 UIKit）
- 行模型：纯 Swift struct；Expo `@Record` 只留在包装边界做映射
- `LodyAppearanceView` 的换肤通知抽成不依赖 Expo 的观察，list 芯也能用

`ChatComposerView`、`ChatAttachments`、`ChatAttachmentSheet`、`ChatComposerModelPanel`、玻璃面、字符串、强调色，扩展直接编。不要把 `LodyComposerView`（Expo 接力包装）编进扩展。

### `LodyCreateSessionController`

`apps/mobile/modules/lody-kit/ios/CreateSession/`。`UINavigationController`：

- 根页：现 ComposerSheet 布局（项目 / Chat 分页 + 底部 composer）
- push：项目、机器、Agent、模型。模型页语义对齐现 `ModelScreen`（权限、fast、collaboration、preset、effort），不是只用 composer 里的小 panel
- composer 留在根页；push picker 时草稿仍在内存
- GitHub 项目显示 branch 行；扩展里不能搜仓库，只能选快照里已有的项目（含 catalog 里已出现的 `github:`）

表单逻辑（context、remembered project、options、prefs、canSend、组 `creation` JSON）全在 Swift，不在 RN hook。单文件超过 500 行就按 controller / form / model / pickers 拆。

### 宿主协议

```swift
protocol LodyCreateSessionHosting: AnyObject {
  var snapshot: ShareSnapshot { get }
  func loadOptions(projectId: String?, chat: Bool) async throws -> CreationOptions
  func persistPrefs(_ prefs: CreatePrefs)
  func submit(_ draft: CreateSessionDraft)
}
```

- App：LocalStore catalog + DataRuntime `sessionCreationOptions`；`persistPrefs` 写 LocalStore 并刷新 App Group 快照；`submit` 经 Expo 事件回 RN，走现有 `outbox.put` + composer 接力
- 扩展：`loadOptions` 只读快照缓存；没有缓存则 `canSend == false`；`submit` 写 inbox 再 `open`

### RN 包装

`CreateSessionScreen` 不再实现 `useCreationForm`、不再 `push(ProjectPickerScreen | PickerScreen | ModelScreen)`。它只：

- `definePage` 的 presentation（formSheet、透明头、detents）
- embed `NativeCreateSession`（`requireNativeView('LodyKit', 'LodyCreateSessionView')`）
- 把 nav intent 的 `workspaceId` / `projectId` / `context` / `sendHandoff` 传进去
- `onCreated` → 现 `useBindSessionNav` 打开会话

`ComposerSheet.tsx` 留给 Debug 的 composer 预览，新建生产路径不用。`ProjectPickerScreen` / `ModelScreen` 的 RN 页可留着给 Debug 或其它入口，生产新建不 present 它们。

### Share Extension

`apps/mobile/modules/lody-kit/share-extension/ShareViewController.swift`：

- `NSExtensionPrincipalClass`
- 用现有 `ChatAttachment.transferType` / `paste` / `loadPlainText` 收 `NSItemProvider`
- present `LodyCreateSessionController`

Ruby：`lody_share_extension(bundle_id)`，point `com.apple.share-services`，suffix `share`，display name `Lody`，Swift 6，自动签名，App Group `group.{bundle_id}`。白名单用 **file reference** 指向 `modules/lody-kit/ios/` 源文件，与 Live Activity 的 copy 不同，避免第二份 composer。

`lody_share_extension` 把 app 的 `Localizable.xcstrings` 加进扩展 resources。`LodyStrings` 读 `Bundle.main`，扩展的 main bundle 是 appex。

新 config plugin `withShareExtension.js`（不要塞进 OneSignal 插件）在 Podfile 里调 helper。不改只存在于生成 `ios/` 的文件。

## 数据

App Group 根：`group.app.innei.lody`（已有）。目录：

```
Library/LodyShare/snapshot.json
Library/LodyShare/inbox/{id}/manifest.json
Library/LodyShare/inbox/{id}/files/...
```

快照和 inbox **不含** Keychain、token、grant。

### 快照

主 App 在这些时机重写 `snapshot.json`：账号/workspace 变化、catalog 投影更新、create prefs 变更、某次 `sessionCreationOptions` 成功。登出写「未登录」快照并清 inbox。

```json
{
  "userId": "…",
  "workspaceId": "…",
  "loggedIn": true,
  "projects": [],
  "prefs": {},
  "options": {
    "chat": {},
    "project:<id>": {}
  },
  "recentSessions": []
}
```

`projects` 只含可创建项目（排除 chat-only id）。`prefs` 形状与现 `CreatePrefs` 相同。`options` 是上次成功的 `CreationOptions` JSON，扩展用它填机器 / Agent / 模型；App 内宿主仍 live 拉并回写。`recentSessions` 初版恒为 `[]`，形态 3 再填。缓存的 `options.sessionId` **不要**拿来创建；每次发送新 UUID。

### Inbox manifest

```json
{
  "id": "uuid",
  "userId": "…",
  "workspaceId": "…",
  "destination": "new",
  "session": {},
  "send": {},
  "createdAt": 0
}
```

`session` / `send` 与现 `outbox.put({ session, send })` 同一形状。`send.attachments` 的 `uri` 指向 inbox `files/` 下的文件。`destination` 初版只写 `"new"`；以后才有 `"session"` + `sessionId`。

`SessionAttachments.upload` 要求文件在 App **自己的** `temporaryDirectory` 下。消费 inbox 时先把附件拷进 App temp（`ChatAttachment.store`），再 `outbox.put`。不要放宽上传路径去读 App Group。

## 数据流

**分享 ingest**

1. URL：写入 composer 文本。若同时有纯文本且不是同一 URL，标题在前、空行、再 URL。
2. 图 / 视频 / 文件：按 `ChatAttachment` 规则当附件。视频不当图。
3. `com.apple.webarchive`：丢弃。
4. Safari 同时给 URL 和预览图：两者都收（URL 进文本，预览进附件）。不单独猜「这是网页缩略图」。
5. 超上限：按现上传错误，多出来的丢掉并提示。
6. 没有任何 item：仍出示 sheet，空草稿，Send 不可用直到有文本或附件。

**扩展发送**

1. 组 draft（新 session UUID、choice、creation JSON、正文、附件）。
2. 拷附件到 `inbox/{id}/files/`，写 manifest。
3. `extensionContext.open(lody://share/{id})`，完成后再 `completeRequest`。
4. 写盘失败：恢复草稿，不 open。

**主 App 消费**

不要把 share URL 解析成 `/{workspace}/sessions/{id}`（此时会话还不存在）。

`redirectSystemPath` / SceneDelegate 对 `lody://share/{id}` 拦截，不让 Expo Router 当页面。Swift 在前台和冷启动 **drain** `LodyShare/inbox/`，URL 只是唤醒。

消费顺序（对齐推送协调器，不新做一套导航）：

1. 等本地账号就绪
2. `manifest.userId` 对不上当前用户 → 丢掉该 inbox（账号切换栅栏，与推送 `recipientUserId` 同类）
3. workspace 不一致 → 先切 workspace，等 catalog
4. 附件拷进 temp
5. `outbox.put`（与新建 sheet 同一条调度）
6. `requestOpenSession`
7. 成功后再删该 inbox 目录

`outbox.put` 失败：不删 inbox，toast。创建/发送失败：现有 outbox `failed` + 会话里草稿恢复。连续分享：按目录排队，一次一条。取消分享：不写 inbox。

**App 内新建**

同一控制器 live `loadOptions`。根页的输入永远是 `ChatComposerView`（扩展编得过）。App 里 `LodyCreateSessionView` 在 submit 时把这只 composer 登记进现有 `LodyComposerView.relays`，`LodyChatView` 仍 `adopt` 同一实例，`send-handoff` 不断。扩展没有 AppContext，不登记 relay。

包装是铺满的 child view controller。键盘重叠和 composer 高度由宿主在窗口坐标里量，RN 不再给 NativeComposer 做 height state。`present()` 的 morph / detents 仍在 RN 壳上。

## 失败与空态

| 情况                            | 行为                                                           |
| ------------------------------- | -------------------------------------------------------------- |
| 未登录 / 快照 `loggedIn: false` | notice，Send 不可用；扩展提供打开主 App                        |
| 无 agent / 无缓存 options       | 现有 `create.composer.needAgent` / loading notice              |
| 附件拷贝失败                    | 丢掉该项，其余继续，提示                                       |
| inbox 写失败                    | 恢复草稿，不 open                                              |
| `openURL` 失败                  | inbox 留着，下次前台 drain                                     |
| 消费时账号不一致                | 丢弃 inbox                                                     |
| `outbox.put` 失败               | 不删 inbox                                                     |
| GitHub 现场搜 / mentions        | 扩展没有；App 内宿主仍可 live（mentions 仍走现 composer 能力） |

## 签名与预构建

- App ID `app.innei.lody.share`，同一 team，App Group `group.app.innei.lody`
- 自动签名，`DEVELOPMENT_TEAM` 从 app target 拷，与 NSE 相同
- `NSExtensionActivationRule`：`SupportsText`；WebURL / Image / File 各 max 8（再由 16/8/8 业务上限裁）
- 不在生成 `ios/` 里手改；plugin + ruby helper 必须能在 `pnpm prebuild` 后重建

## 验收

全部离线：不登录、无云、无真 Share 面板。系统分享 sheet 不作为 CI 门槛。

**原生** `modules/lody-kit/verification/share`：ingest（URL/文本/图/文件/webarchive/上限）、快照编解码且无凭据字段、inbox 写读删与排队、`destination` 只有 `new`、每次新 UUID、消费前附件落到 app temp。

**Debug** 独立场景：embed 同一控制器，注入假快照和分享 payload。可切项目/Chat、进模型页、发送。发送走 inbox → outbox → 打开会话；成功/失败由 Debug 注入。不初始化 OneSignal，不 present 系统 Share。

**`verify:ui`** 新 case 覆盖该 Debug 场景：预填链接/图的 sheet（两套外观）、发送后进会话且第一句已在飞、未登录/无 agent 时 Send 不可用。现有 `send-handoff`、`model-memory`、`morph`、`project-picker`、`composer`、`outbox` 必须仍过。剥 list Expo 时 `list` / `home` 是回归网。扩展路径不断言 composer 实例接力。

## 形态 3（不做，只留位）

快照已有 `recentSessions`。inbox `destination` 可从 `"new"` 扩到 `"session"`。到时在同一宿主上加目的（最近 / 当前排最上 + 新建），不是第二个扩展。当前会话（形态 2）被这个选择器覆盖，不单开路径。

## 风险

- 剥 list Expo 会碰到所有 grouped/paged 列表。包装类名和 RN props 不变，行为验收靠现有 `list` / `home` / `project-picker`。
- 扩展内存紧。只编 UIKit 子集，不载 DataRuntime / WebView。附件落到磁盘，不要把全部分享图解进内存。
- `extensionContext.open` 在部分系统版本上不可靠。drain 是真相源；用户只关分享面板、没进 Lody 时，下次打开 App 仍会消费。
- 快照里的 machines/agents 会过期。扩展用缓存发出；主 App live 创建若 agent 已没，走现有 outbox 失败 + 草稿恢复。
