# Lody iOS `src/` 结构重组

## 问题

`apps/mobile/src` 按历史习惯堆叠：页面、`definePage`、runtime、catalog 解码和 React Provider 混在 `features/` 与扁平的 `cloud/` 里。同一页面有的叫 `*Screen`、有的叫 `*Page`；有的是 `export default`，有的是 `sessionPage`。`features/sessions/navigation.ts` 直接 `present(sessionPage)`，领域层和页面定义绑死。`DetailBlocks.tsx` 同时拥有 `sessionItemDetail` 的 JSON 形状和 React 组件。

结果是：找一个页面要猜目录和导出名字；改打开会话会碰到 feature ↔ screen 循环依赖；业务类型散落在 UI 文件里。

## 目标

按「页面 / 绑定 / 领域 / 协议 / 形状」分开存放，依赖单向，命名统一。不改产品行为、云协议或 `present()` 语义。

## 目录

```text
src/app/                 薄路由，只 re-export XxxScreen.Route
src/screens/             产品页扁平 *Screen；目录里只有 *Screen 文件
src/screens/debug/       Debug / Preview；允许 uiVerify.ts
src/hooks/screens/       mailbox → present，以及 screen 层导航辅助
src/features/sessions/   会话领域（操作、投影、mailbox）
src/models/              业务数据形状
src/cloud/               按 domain：auth / catalog / send + kv
src/presentation/        definePage / present / sheet 宿主，不动
src/ui/                  共享组件（含从业务类型拆出的 DetailBlocks）
src/i18n/                不动；文案仍在 apps/mobile/locales/
src/theme/               不动
```

`features/auth`、`features/settings`、`features/environment`、`features/debug` 在页面迁走后删除。

`apps/mobile/verification/` 不动。Node 单测按源码对齐：

```text
apps/mobile/tests/
  helpers.mjs
  sessions/
  cloud/
  presentation/
  i18n/
  theme/
  native/
```

`pnpm test` 改为递归 `apps/mobile/tests/**/*.test.mjs`。

## 依赖

```text
app → screens / hooks/screens → features → cloud → models
                 ↘ presentation
screens / ui → models
```

硬规则：

- `features` 不得 import `screens` 或 `hooks/screens`。
- `models` 不得 import `cloud` / `features` / `screens` / `ui`。
- `cloud` 不得 import `features` / `screens`。
- `presentation` 不搬进 screens 或 features。
- 被 `node --test` 直接加载的源文件继续用相对路径 + `.ts` 后缀，不依赖 `@/`。

## 命名

每个页面文件导出同一个 `definePage` 对象：

```ts
function View() {
  /* … */
}

export const SessionScreen = definePage({
  id: 'session',
  title: t('session.title'),
  Component: View,
  parseRouteParams: () => {
    throw new Error('请从会话列表打开');
  },
  presentation: { style: 'push', headerVariant: 'transparent' },
});
```

- 文件名、导出名都是 `PascalCase` + `Screen`。
- `present(SessionScreen, …)` 与 `SessionScreen.Route` 用同一导出。
- 内部组件不得再叫 `SessionScreen`，用 `View`。
- Tab 根页面（Inbox / Search / Settings）也包 `definePage`。
- 路由文件一律 `export default XxxScreen.Route`。
- `src/ui/Screen.tsx` 是布局壳，不改名。
- `src/screens/` 与 `src/screens/debug/` 不得放非 `*Screen` 文件。`LoginPanel` 折进 `InboxScreen.tsx`。`uiVerify` 进 `screens/debug/uiVerify.ts` 是 debug 目录例外（不是产品 `screens/` 根）。

现有 `*Page` 文件改名对照：

| 现在                              | 之后                                   |
| --------------------------------- | -------------------------------------- |
| `permissionPage`                  | `PermissionScreen`                     |
| `processPage`                     | `ProcessScreen`                        |
| `itemDetailPage`                  | `ItemDetailScreen`                     |
| `filePage`                        | `FileScreen`                           |
| `fileDiffPage`                    | `FileDiffScreen`                       |
| `turnChangesPage`                 | `TurnChangesScreen`                    |
| `environmentPage` 等 `*Page` 导出 | 同文件的 `*Screen` 导出                |
| Debug `*Preview.tsx`              | `src/screens/debug/*PreviewScreen.tsx` |

Inbox 内嵌的 settings sheet 抽成 `InboxSettingsScreen.tsx`。

## 打开会话：mailbox

`present(SessionScreen)` / `present(CreateSessionScreen)` 不得出现在 `features/`。

`features/sessions/sessionNav.ts` 只发意图、归还 Promise：

```ts
requestOpenSession(session: Session): Promise<void>
requestNewSession(
  workspaceId: string,
  catalog: Catalog,
  projectId?: string,
): Promise<void>
subscribeSessionNav(handler: (intent: SessionNavIntent) => Promise<void>): () => void
```

`src/hooks/screens/useBindSessionNav.ts` 挂在始终活着的 Tab layout，订阅 mailbox，内部才 `present`。创建成功后再推进会话页，也放在 hook 里。

`sessionNav.ts` 只排队和兑现 Promise，不 import toast / RN，以便 `node --test` 直载。打开/创建失败的 toast 放在 `useBindSessionNav`（文案 key 与现 `openSession` / `newSession` 相同）。`request*` 在 handler 抛错时仍 resolve，避免调用方未处理 rejection。

`archive` / `pin` 留在 `features/sessions`（例如 `sessionActions.ts`），不进 mailbox。

`openCatalogRow`：项目走稳定 URL（`router.push`），会话走 `requestOpenSession`。这是 screen 层导航，放 `src/hooks/screens/openCatalogRow.ts`。

`useProcessSheet` 从 `processPage.tsx` 挪到 `src/hooks/screens/useProcessSheet.ts`。

## `src/models/`

只放业务数据形状，不放页面参数、端口函数、UI props。

```text
src/models/
  auth.ts        User、Workspace、DeviceCode、SavedAccount
  catalog.ts     Project、Session、Catalog、SavedCatalog、Connection
  session.ts     Envelope、EntrySummary、ItemSummary、Snapshot、
                 DetailBlock、DetailResponse、
                 PermissionTarget、PermissionTargetState、
                 PermissionOption、PermissionDetail、PermissionResult
  send.ts        Capability、CapabilityChoice、CreationOptions、
                 PendingSend、PendingSession、
                 ModelChoice、ProjectPrefs、CreatePrefs、CreatedSession
```

留下不动：

- `ItemDetailParams` / `PermissionParams` / `FilesParams` 等 — 跟 `definePage` 走
- `PermissionService`、`PermissionTargetSource` — 端口
- `projectRows`、`fetchDetail`、`capabilityFor` — 解码或操作
- `Palette`、`TranslationKey`、`ButtonVariant`

`cloud/model.ts` 的类型搬走，解码留在 `cloud/catalog`。`features/sessions/transcript/types.ts` 的信封类型搬走后删除该文件（或改成从 models 再导出；优先删除，调用方改 import）。

## `src/cloud/`

按 domain 收。共享 KV 只留工具；key 和 `Saved*` 跟 domain 走。

```text
src/cloud/
  kv.ts                      read / write / parse / generation / clear
  auth/
    api.ts                   现 auth.ts 的 HTTP / Device Flow
    persist.ts               account key、selectionKey、SavedAccount 读写
    AuthProvider.tsx
  catalog/
    model.ts                 projectRows 等解码（类型来自 models）
    runtime.ts
    load.ts                  现 catalog.ts
    persist.ts               catalogKey、SavedCatalog
    connection.ts
    CatalogProvider.tsx
  send/
    capability.ts            capabilityFor
    pendingSends.ts          自有 `pending-sends:` key
```

登出时的全局 `clear()` 在 `kv.ts`，不属于任一 domain。

`AuthProvider` 启动仍可读一份 `SavedCatalog`：只从 `catalog/persist` 引类型与读取，不拥有 catalog key。

`createPrefs` 与会话 envelope 缓存是 feature 持久化，直接用 `cloud/kv`。`createPrefsKey` 留在 `features/sessions/createPrefs.ts`。

`useAuth` 从 `@/cloud/auth/AuthProvider`（或 `cloud/auth` barrel）导出。`LoginPanel` 不进 cloud，折进 `InboxScreen`。

## `src/features/sessions/`

屏幕抽走后平铺 + 只留 `transcript/`：

```text
features/sessions/
  sessionNav.ts
  sessionActions.ts          archive / pin
  inbox.ts
  status.ts                  从 ui/status.ts 迁来
  createPrefs.ts
  draftTitle.ts
  acceptEnvelope.ts
  useSessionRuntime.ts
  useSessionSend.ts
  permissionTarget.ts        firstPermissionTarget / createPermissionGate
  itemDetail.ts              fetchDetail
  path.ts                    basename / dirname
  transcript/
    aggregate.ts
    changes.ts
    types.ts                 删除，改从 models/session 引用
```

`DetailBlock` / `DetailResponse` 进 models；`Blocks` / `CommandBlock` 等进 `src/ui/DetailBlocks.tsx`，props 引用 models。`fetchDetail` 留在 feature。

## `src/ui/` / `i18n` / `theme`

- `ui` 只留共享组件与列表文案/相对时间：`Screen`、`Button`、`AppText`、`toast`、`platform`、`listState`、`time`、`DetailBlocks`。
- `status.ts` 离开 ui。
- `src/i18n/` 与 `apps/mobile/locales/` 不动。
- `src/theme/` 不动。

## 页面落点

产品（`src/screens/`，扁平）：

`InboxScreen`、`InboxSettingsScreen`、`SearchScreen`、`SettingsScreen`、`AccountScreen`、`EnvironmentScreen`、`ProjectScreen`、`ProjectPickerScreen`、`SessionScreen`、`CreateSessionScreen`、`ModelScreen`、`PickerScreen`、`DirectoryScreen`、`FilesScreen`、`FileScreen`、`PermissionScreen`、`ProcessScreen`、`ItemDetailScreen`、`TurnChangesScreen`、`FileDiffScreen`。

Debug（`src/screens/debug/`）：

`DebugScreen`、`ChatPreviewScreen`、`SendPreviewScreen`、`ShinePreviewScreen`、`BackgroundPreviewScreen`、`InboxPreviewScreen`、`ComposerPreviewScreen`、`HomePreviewScreen`。

## 文档

实施时同步改：

- `docs/architecture.md`：页面在 `src/screens`，不再写「definePage 放在 features」。
- `CLAUDE.md` / `AGENTS.md`：`Routes live in src/app, screens in src/screens, domain in src/features, shapes in src/models, cloud protocol in src/cloud, shared UI in src/ui`。

## 非目标

- 不改 `present()` / `definePage` 的运行时语义。
- 不改 native kit、data-runtime、文案 key、云端协议。
- 不做通用 present-intent bus。
- 不把 `verification/ui` 并进 Node 单测。
- 不把 `models` 做成 Zod/校验层。
- 不拆 `features/inbox` 与 `features/session`。

## 验收

- `pnpm check`、`pnpm test` 通过。
- `features/` 与 `cloud/` 的 import 图满足上方依赖（可用 ripgrep 抽查：features 不得出现 `@/screens`）。
- `src/screens/` 根目录只有 `*Screen.tsx`。
- 产品打开/新建会话路径仍通过 mailbox，行为与现在一致（失败 toast、创建成功推进会话）。
- UI verification 场景名单不因改路径而缺场景；Debug 入口仍从 Settings 进入。
