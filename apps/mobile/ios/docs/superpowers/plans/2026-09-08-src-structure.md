# src 结构重组 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/mobile/src` 收成单向依赖：screens / hooks / features / cloud / models，页面统一 `export const XxxScreen = definePage(...)`，打开会话经 mailbox，不改产品行为。

**Architecture:** 先抽 `models` 和 `cloud` domain（调用方改 import，页面仍在 features）。再加 mailbox 与 bind hook。最后搬 `*Screen`、删空 feature、按目录重放单测。每一 task 结束仓库必须能 `pnpm check` + `pnpm test`。

**Tech Stack:** TypeScript / React Native 0.86 / Expo Router / Node 22.13+ `node --test` / 现有 `@lody-ios/kit`

**Spec:** `docs/superpowers/specs/2026-09-08-src-structure-design.md`

## Global Constraints

- **零注释、零 JSDoc**。只有意外 workaround 或非显然不变量可以写注释。
- **不写 Android**，不加 fallback stub。
- **不加新依赖**。
- **单文件 500 行上限，React 组件 300 行上限。** `InboxScreen` 折入 `LoginPanel` 后若超标，把 settings sheet 先抽到 `InboxSettingsScreen`（Task 5），Login 仍作同文件内 `function Login()`。
- **不许 `CODE_SIGNING_ALLOWED=NO`**。
- **原生 API 只从 `@lody-ios/kit` 导入。**
- **不新建 workspace package。**
- **不嵌套三元。**
- 每个 task 结束跑 `pnpm check` 和 `pnpm test`。只对改过的文件跑 `pnpm format`。
- 被 `node --test` 直接加载的源文件必须用相对路径 + `.ts` 后缀。
- `features` 不得 import `screens` / `hooks/screens`；`cloud` 不得 import `features` / `screens`；`models` 不往上指。
- **不改** `present()` / `definePage` 语义、native kit、文案 key、云协议。
- 未到 Task 7 之前，`pnpm test` 仍是 `apps/mobile/tests/*.test.mjs`。

---

## File Structure

**新建**

| 文件                                                                        | 职责                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------- |
| `src/models/auth.ts`                                                        | User / Workspace / DeviceCode / SavedAccount            |
| `src/models/catalog.ts`                                                     | Project / Session / Catalog / SavedCatalog / Connection |
| `src/models/session.ts`                                                     | Envelope 族、Detail*、Permission* 数据                  |
| `src/models/send.ts`                                                        | Capability / Pending* / prefs / CreatedSession          |
| `src/cloud/kv.ts`                                                           | 共享 read/write/parse/generation/clear                  |
| `src/cloud/auth/{api,persist,AuthProvider}.tsx`                             | 认证协议 + 账号持久化 + Provider                        |
| `src/cloud/catalog/{model,runtime,load,persist,connection,CatalogProvider}` | 副本                                                    |
| `src/cloud/send/{capability,pendingSends}.ts`                               | 能力与未完成发送                                        |
| `src/features/sessions/sessionNav.ts`                                       | 打开/新建会话 mailbox                                   |
| `src/features/sessions/sessionActions.ts`                                   | archive / pin                                           |
| `src/features/sessions/itemDetail.ts`                                       | fetchDetail                                             |
| `src/features/sessions/status.ts`                                           | 从 ui/status 迁来                                       |
| `src/features/sessions/path.ts`                                             | basename / dirname                                      |
| `src/hooks/screens/useBindSessionNav.ts`                                    | mailbox → present                                       |
| `src/hooks/screens/useProcessSheet.ts`                                      | 进程 sheet                                              |
| `src/hooks/screens/openCatalogRow.ts`                                       | 项目 URL + requestOpenSession                           |
| `src/ui/DetailBlocks.tsx`                                                   | 详情块组件                                              |
| `src/screens/*.tsx`                                                         | 产品页（Task 5 迁入）                                   |
| `src/screens/debug/*`                                                       | Debug 页（Task 6）                                      |
| `tests/sessions/session-nav.test.mjs`                                       | mailbox 单测                                            |

**删除（对应 task 完成后）**

`src/cloud/{auth,catalog,model,local,runtime,connection,pendingSends,CatalogProvider}.ts(x)` 旧扁平文件；`src/features/{auth,settings,environment,debug}`；`src/ui/status.ts`；`src/features/sessions/transcript/types.ts`（调用方改指 models）；旧 `*Page.tsx` / 散落 Screen。

---

### Task 1: 抽出 `src/models`

把业务类型集中到四份文件。旧模块改为从 models 再导出同名类型（本 task 先保持旧路径能编译，避免一次改完所有 import）。`projectRows` / `capabilityFor` 仍留在现文件。

**Files:**

- Create: `apps/mobile/src/models/auth.ts`
- Create: `apps/mobile/src/models/catalog.ts`
- Create: `apps/mobile/src/models/session.ts`
- Create: `apps/mobile/src/models/send.ts`
- Modify: `apps/mobile/src/cloud/auth.ts`（删类型定义，`export type { … } from '../models/auth.ts'`）
- Modify: `apps/mobile/src/cloud/model.ts`（类型改再导出；`projectRows` / `capabilityFor` 留下）
- Modify: `apps/mobile/src/cloud/local.ts`（Saved* 再导出）
- Modify: `apps/mobile/src/cloud/connection.ts`（Connection 再导出）
- Modify: `apps/mobile/src/cloud/pendingSends.ts`（Pending* 再导出）
- Modify: `apps/mobile/src/features/sessions/transcript/types.ts`（整文件改成再导出 models/session）
- Modify: `apps/mobile/src/features/sessions/createPrefs.ts`（类型再导出；值仍在本文件）
- Modify: `apps/mobile/src/features/sessions/detail/DetailBlocks.tsx`（类型改为从 models 引，组件留下）
- Modify: `apps/mobile/src/features/sessions/detail/permissionTarget.ts`（数据 type 再导出，函数留下）
- Modify: `apps/mobile/src/features/sessions/detail/permissionPage.tsx`（PermissionOption / PermissionDetail 从 models 引）
- Modify: `apps/mobile/src/features/sessions/ModelScreen.tsx`（ModelChoice 从 models 引）
- Modify: `apps/mobile/src/features/sessions/CreateSessionScreen.tsx`（CreatedSession 从 models 引）
- Modify: `apps/mobile/src/features/sessions/useSessionRuntime.ts`（Snapshot 从 models 引）

**Interfaces:**

- Produces: spec「`src/models/`」四份文件的全部 type 名，字段与现定义逐字相同。
- `Snapshot` = `Omit<Envelope, 'v'>`，写在 `models/session.ts`。

- [ ] **Step 1: 写入四份 models（只含 type，无运行时）**

从现文件剪贴类型，不要改字段。`models/*` 不得 import `cloud` / `features` / `@/`。

`auth.ts`：`User`、`Workspace`、`DeviceCode`、`SavedAccount`。

`catalog.ts`：`Project`、`Session`、`Catalog`、`SavedCatalog`、`Connection`。

`session.ts`：现 `transcript/types.ts` 全部 + `DetailBlock` + `DetailResponse` + `PermissionTarget` + `PermissionTargetState` + `PermissionOption` + `PermissionDetail` + `PermissionResult` + `Snapshot`。

`send.ts`：`CapabilityChoice`、`Capability`、`CreationOptions`、`PendingSend`、`PendingSession`、`ModelChoice`、`ProjectPrefs`、`CreatePrefs`、`CreatedSession`。

- [ ] **Step 2: 旧文件改为再导出**

例：

```ts
export type {
  User,
  Workspace,
  DeviceCode,
  SavedAccount,
} from '../models/auth.ts';
```

`createPrefs.ts` 删除 `ProjectPrefs` / `CreatePrefs` / `ModelChoice` 定义，改为 `export type { … } from '../../models/send.ts'`，函数体继续用这些名字。

`transcript/types.ts` 变成一行再导出（本 task 先留文件，让现有相对 import 不断）。

- [ ] **Step 3: 跑测试**

```sh
pnpm test
pnpm check
```

Expected: PASS。行为不变。

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/models apps/mobile/src/cloud apps/mobile/src/features
git commit -m "$(cat <<'EOF'
Extract business types into src/models.

EOF
)"
```

---

### Task 2: `cloud/` 按 domain 拆，迁 AuthProvider

**Files:**

- Create: `apps/mobile/src/cloud/kv.ts`（现 `local.ts` 的 generation / parse / read / write / clear，不含 key 与 Saved*）
- Create: `apps/mobile/src/cloud/auth/api.ts`、`persist.ts`、`AuthProvider.tsx`
- Create: `apps/mobile/src/cloud/catalog/{model,runtime,load,persist,connection,CatalogProvider}.tsx`
- Create: `apps/mobile/src/cloud/send/capability.ts`、`pendingSends.ts`
- Create: `apps/mobile/src/cloud/auth.ts` 与 `apps/mobile/src/cloud/catalog.ts` 仅当需要短路径再导出；否则更新所有 import 后删除扁平文件
- Modify: `_layout.tsx` 的 AuthProvider / CatalogProvider import
- Modify: `apps/mobile/tests/local-cache.test.mjs` entryPoint → `src/cloud/kv.ts`；`catalogKey` 断言改为 import `src/cloud/catalog/persist.ts`
- Modify: `apps/mobile/tests/pending-sends.test.mjs` mock 路径 `./local` → `../kv`（相对 `send/pendingSends.ts`）
- Modify: `apps/mobile/tests/cloud.test.mjs` 以及所有 `@/cloud/…` import
- Delete: 旧扁平 `src/cloud/local.ts`、`auth.ts`（若已无引用）、`model.ts`、`runtime.ts`、`connection.ts`、`pendingSends.ts`、`CatalogProvider.tsx`、旧 `catalog.ts`（load 已迁走后）
- Delete: `src/features/auth/AuthProvider.tsx`（迁走后）

**Interfaces:**

- Consumes: `models/*`、`@lody-ios/kit` 的 local / auth 原生 API
- Produces:
  - `readLocal<T>(key)` / `writeLocal(key, value, generation?)` / `clearLocal()` / `localGeneration()` / `parseLocal<T>(value)` — 从 `cloud/kv.ts`
  - `catalogKey(userId, workspaceId)` / `selectionKey(userId)` — `cloud/catalog/persist.ts`
  - `accountKey = 'account'` 与 SavedAccount 读写 — `cloud/auth/persist.ts`
  - `capabilityFor` — `cloud/send/capability.ts`
  - `export function useAuth` — 仍从 AuthProvider 文件导出
  - `CatalogProvider` / `useCatalog` / `CatalogContext` — 仍从 CatalogProvider 导出

`pendingSends.ts` 改为 `import { localGeneration, readLocal, writeLocal } from '../kv.ts'`。esbuild 测试里把 filter 改成 `/^(react|\.\.\/kv)$/` 或 `filter: /kv\.ts$/`。

`createPrefs.ts` 的 `capabilityFor` 相对路径改为 `../../cloud/send/capability.ts`。

`AuthProvider` 从 `@/features/auth/AuthProvider` 改为 `@/cloud/auth/AuthProvider`。`LoginPanel` 仍从 `./AuthProvider` 改成 `@/cloud/auth/AuthProvider`（文件还在 features/auth）。

- [ ] **Step 1: 先落 `kv.ts`，把 `local-cache.test.mjs` 指过去并跑红/绿**

`local-cache.test.mjs` 的 `entryPoints` 改为 `apps/mobile/src/cloud/kv.ts`。把 `catalogKey` 断言挪到同一测试文件底部，额外 bundle 或直接 `import { catalogKey } from '../src/cloud/catalog/persist.ts'`（persist 无 kit 依赖即可直 import）。

先写 persist：

```ts
import type { SavedCatalog } from '../../models/catalog.ts';

export const catalogKey = (userId: string, workspaceId: string) =>
  `catalog:${userId}:${workspaceId}`;
```

- [ ] **Step 2: 按 spec 树移动其余 cloud 文件并改 import**

不要改函数逻辑。`CatalogProvider` 不再从 features 引 Auth，改为 `@/cloud/auth/AuthProvider`。

- [ ] **Step 3: 迁 AuthProvider，删 `features/auth/AuthProvider.tsx`**

- [ ] **Step 4: 跑 `pnpm test` 与 `pnpm check`**

Expected: PASS。`pending-sends` 与 `local-cache` 必须绿。

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/cloud apps/mobile/src/features/auth apps/mobile/src/app apps/mobile/tests apps/mobile/src/features/sessions/createPrefs.ts
git commit -m "$(cat <<'EOF'
Split cloud into auth, catalog, and send domains.

EOF
)"
```

---

### Task 3: 拆 DetailBlocks，迁 status / path / fetchDetail

**Files:**

- Create: `apps/mobile/src/ui/DetailBlocks.tsx`（组件 only，`import type { DetailBlock } from '@/models/session'`）
- Create: `apps/mobile/src/features/sessions/itemDetail.ts`（`fetchDetail`）
- Create: `apps/mobile/src/features/sessions/status.ts`（现 `ui/status.ts` 原文）
- Create: `apps/mobile/src/features/sessions/path.ts`

```ts
export const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) || path;
export const dirname = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).slice(0, -1).join('/');
```

- Modify: `itemDetailPage.tsx` / `permissionPage.tsx` / `ChatPreview.tsx` / `SessionScreen.tsx` 的 import
- Modify: `inbox.ts`：`status` 改相对 `./status.ts`
- Modify: `apps/mobile/tests/session-row.test.mjs`：status import 改 `../src/features/sessions/status.ts`
- Modify: `permissionTarget.ts`：删已再导出的 type 定义，改为 `export type { … } from '../../models/session.ts'`（保持 node:test 相对路径）
- Delete: `src/ui/status.ts`
- Delete: `DetailBlocks.tsx` 里的 type（文件若只剩组件则整文件挪到 ui 后删 feature 副本）

- [ ] **Step 1: 搬文件，改 import，不改行为**

- [ ] **Step 2: `pnpm test` && `pnpm check`**

Expected: `session-row`、`permission-gate`、`inbox` 仍绿。

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/ui/DetailBlocks.tsx apps/mobile/src/features/sessions apps/mobile/src/ui/status.ts apps/mobile/tests
git commit -m "$(cat <<'EOF'
Split detail block types from UI and move session status out of ui.

EOF
)"
```

---

### Task 4: mailbox + bind hook（先写测试）

**Files:**

- Create: `apps/mobile/src/features/sessions/sessionNav.ts`
- Create: `apps/mobile/src/features/sessions/sessionActions.ts`
- Create: `apps/mobile/src/hooks/screens/useBindSessionNav.ts`
- Create: `apps/mobile/src/hooks/screens/openCatalogRow.ts`
- Create: `apps/mobile/src/hooks/screens/useProcessSheet.ts`
- Create: `apps/mobile/tests/session-nav.test.mjs`（本 task 仍放扁平 tests/，Task 7 再搬）
- Modify: `navigation.ts` 调用方改 `requestOpenSession` / `requestNewSession` / `sessionActions`；本 task 结束可删 `navigation.ts`
- Modify: `apps/mobile/src/app/(tabs)/_layout.tsx` 挂 hook、改 newSession
- Modify: `processPage.tsx` 只留页面，导出 `processPage` 暂仍从此文件（Task 5 再改名）

**Interfaces:**

```ts
import type { Catalog, Session } from '../../models/catalog.ts';

export type SessionNavIntent =
  | { kind: 'open'; session: Session }
  | {
      kind: 'create';
      workspaceId: string;
      catalog: Catalog;
      projectId?: string;
    };

export function requestOpenSession(session: Session): Promise<void>;
export function requestNewSession(
  workspaceId: string,
  catalog: Catalog,
  projectId?: string,
): Promise<void>;
export function subscribeSessionNav(
  handler: (intent: SessionNavIntent) => Promise<void>,
): () => void;
```

实现：队列 + 单一 handler。无订阅时 intent 排队；handler 返回则 resolve，抛错则 reject。`request*` 内 try/catch toast，文案 key 与现 `openSession` / `newSession` 相同。

`useBindSessionNav`：

```ts
useEffect(() => {
  return subscribeSessionNav(async (intent) => {
    if (intent.kind === 'open') {
      await present(
        sessionPage,
        { session: intent.session },
        { title: intent.session.title },
      );
      return;
    }
    const result = await present(createSessionPage, {
      workspaceId: intent.workspaceId,
      projects: intent.catalog.projects,
      projectId: intent.projectId,
    });
    if (result.status === 'completed')
      await present(
        sessionPage,
        {
          session: result.value.session,
          modelId: result.value.modelId,
          effort: result.value.effort,
          modeId: result.value.modeId,
        },
        { title: result.value.session.title },
      );
  });
}, []);
```

本 task 仍引用 features 里的 `sessionPage` / `createSessionPage`（尚未改名）。Task 5 改成 `SessionScreen` / `CreateSessionScreen`。

`openCatalogRow(id, catalog)`：`id.startsWith('project:')` 则 `router.push({ pathname: '/project/[projectId]', params: { projectId: id.slice(8) } })`，否则 `void requestOpenSession(session)`。

- [ ] **Step 1: 写失败测试 `tests/session-nav.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../src/i18n/index.ts';
import {
  requestOpenSession,
  requestNewSession,
  subscribeSessionNav,
} from '../src/features/sessions/sessionNav.ts';

setLocale('en');

const session = {
  id: 's1',
  machineId: 'm',
  title: 'T',
  status: 'idle',
  archived: false,
  pinned: false,
  projectId: 'p',
  createdAt: '2026-01-01',
};

test('requestOpenSession waits for the subscriber and preserves order', async () => {
  const seen = [];
  const stop = subscribeSessionNav(async (intent) => {
    seen.push(intent.kind);
  });
  await requestOpenSession(session);
  assert.deepEqual(seen, ['open']);
  stop();
});

test('intents queue until a subscriber attaches', async () => {
  const seen = [];
  const pending = requestOpenSession(session);
  const stop = subscribeSessionNav(async (intent) => {
    seen.push(intent.kind);
  });
  await pending;
  assert.deepEqual(seen, ['open']);
  stop();
});

test('handler throw rejects the request', async () => {
  const stop = subscribeSessionNav(async () => {
    throw new Error('boom');
  });
  await assert.rejects(requestOpenSession(session), /boom/);
  stop();
});
```

`request*` 若内部吞掉错误并 toast，把「上抛」留给 `enqueue`，toast 包在对外函数里：测试应 import 内部 `enqueue` 或让 `requestOpenSession` 在测试环境不 toast。做法：`requestOpenSession` 调用 `enqueue` 后 `.catch` toast **并且不再抛**（与今天 `openSession` 一致）。上面对外行为测试应改成：

- 有 subscriber 时 `await requestOpenSession(session)` resolve（即使要测 throw，测 `subscribe` 的 handler 用一个不带 toast 的 `enqueue` 导出太脏）。
- 只测：排队、顺序、handler 完成后 request resolve。
- handler throw：`requestOpenSession` 仍 resolve（已 toast），另测 `subscribe` 的 raw enqueue。更简单：**request 吞错**；测试不写 throw 例，改测「handler throw 不导致未处理 rejection」：

```js
test('handler throw is swallowed by requestOpenSession', async () => {
  const stop = subscribeSessionNav(async () => {
    throw new Error('boom');
  });
  await requestOpenSession(session);
  stop();
});
```

需要 mock `showToast`：`sessionNav.ts` 从 `@/ui/toast` 改成相对 `../../ui/toast.ts`，测试用 `module.mock` 或把 toast 做成可注入。最省事：`sessionNav.ts` 不 import toast，由 `request*` 的调用方 toast——但 spec 写的是 request 内 toast。

用相对 import toast，测试里：

```js
import { mock } from 'node:test';
```

若 toast 拉 RN，改为 sessionNav 只 `enqueue`，再包一层 `requestOpenSession` 在同文件 try/catch；catch 里动态 import toast 会更脏。

**选定实现：** `sessionNav.ts` 只 export `enqueue` 语义的三个函数；toast 留在 `requestOpenSession` / `requestNewSession`，从相对路径 import toast。若 `pnpm test` 加载 toast 失败，把 toast 调用改成：

```ts
import { showToast } from '../../ui/toast.ts';
```

若该文件在 node 里不能跑，则 mailbox 文件零 RN：不 toast；`requestOpenSession` 只 enqueue；toast 放到 `useBindSessionNav` 的 catch **以及** 无 hook 时的调用方。与 spec「request 内 toast」冲突时以 **mailbox 可被 node 直测** 为准：toast 放 hook 与 Tab 按钮的 catch（`_layout.tsx` 已有 creating 与 sign-in toast）。`openSession` 现有 toast 迁到 hook：

```ts
try {
  await present(...)
} catch {
  showToast(t(intent.kind === 'open' ? 'session.toast.openFailed' : 'session.toast.createFailed'));
  throw error; // 或不再抛，request 仍 resolve
}
```

测试只覆盖队列与 resolve。按此写 `sessionNav.ts`，**不要**在 mailbox 里 import toast。

- [ ] **Step 2: 跑测试确认失败**

```sh
node --experimental-strip-types --experimental-test-module-mocks --test apps/mobile/tests/session-nav.test.mjs
```

Expected: FAIL，`sessionNav.ts` 不存在。

- [ ] **Step 3: 实现 mailbox，测试转绿**

- [ ] **Step 4: 抽出 sessionActions，接 hook，删 navigation 里的 present**

`useProcessSheet` 原样搬到 hooks，仍 `present(processPage)`。

`_layout.tsx`：`useBindSessionNav()`；`newSession` → `requestNewSession`。

Inbox / Project / Session / Search 改为 `request*` + `openCatalogRow`。

- [ ] **Step 5: `pnpm test` && `pnpm check`**

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/features/sessions/sessionNav.ts apps/mobile/src/features/sessions/sessionActions.ts apps/mobile/src/hooks apps/mobile/src/app apps/mobile/src/features/sessions apps/mobile/tests/session-nav.test.mjs
git commit -m "$(cat <<'EOF'
Decouple session presentation through a mailbox and bind hook.

EOF
)"
```

---

### Task 5: 产品页迁入 `src/screens/`，导出统一为 `XxxScreen`

**Files:**

把 spec 里的产品页（含 `InboxSettingsScreen`）迁到 `apps/mobile/src/screens/`，扁平。每个文件改为：

```ts
function View() { /* 原组件 */ }
export const FooScreen = definePage({ ..., Component: View });
```

原 `export default function InboxScreen` 改为 `definePage` + `export const InboxScreen`。

路由：

```ts
import { InboxScreen } from '@/screens/InboxScreen';
export default InboxScreen.Route;
```

对：`(tabs)/sessions/index`、`search/index`、`settings/index`、`settings/account`、`project/[projectId]`、`environment`、`debug`（debug 可本 task 先仍指 features，Task 6 再改）。

`useBindSessionNav` 改为 `present(SessionScreen, …)` / `CreateSessionScreen`。

Inbox 的 settings sheet 抽到 `InboxSettingsScreen.tsx`。`LoginPanel` 本 task 先仍从 `features/auth/LoginPanel` 引（Task 6 折入）。

`src/screens/` 根目录不得出现非 `*Screen.tsx`。

改完所有 `@/features/…Screen` 与 `*Page` import。

- [ ] **Step 1: 迁文件并统一导出（git mv + 改 definePage 名）**

- [ ] **Step 2: 改 app 路由与 hooks import**

- [ ] **Step 3: `pnpm check` && `pnpm test`**

Expected: PASS。`features/sessions` 下不再有 `*Screen.tsx` / `*Page.tsx`。

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/screens apps/mobile/src/app apps/mobile/src/hooks apps/mobile/src/features
git commit -m "$(cat <<'EOF'
Move product pages into src/screens with unified Screen exports.

EOF
)"
```

---

### Task 6: Debug 页、折入 LoginPanel、删空 feature

**Files:**

- Move: `features/debug/*Preview.tsx` → `src/screens/debug/*PreviewScreen.tsx`，导出 `export const ChatPreviewScreen = definePage(...)`
- Move: `DebugScreen.tsx` → `src/screens/debug/DebugScreen.tsx`
- Move: `uiVerify.ts` → `src/screens/debug/uiVerify.ts`
- Move: `HomePreview` 的 providers 跟着 `HomePreviewScreen.tsx`（`_layout.tsx` / `index.tsx` 改 import）
- Modify: `InboxScreen.tsx` 折入 `LoginPanel` 为同文件 `function Login()`，改 `useAuth` 为 `@/cloud/auth/AuthProvider`
- Delete: `src/features/auth`、`settings`、`environment`、`debug`

`src/screens/debug/` 可以有 `uiVerify.ts`；产品 `src/screens/` 根仍只有 `*Screen.tsx`。

- [ ] **Step 1: 迁 debug，改 Settings / Debug 入口 import**

- [ ] **Step 2: 折 LoginPanel，删空目录**

- [ ] **Step 3: 抽查**

```sh
rg "from '@/features/(auth|settings|environment|debug)" apps/mobile
rg "sessionPage|createSessionPage|permissionPage" apps/mobile/src
```

Expected: 无匹配（或仅文档）。

- [ ] **Step 4: `pnpm check` && `pnpm test`**

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src apps/mobile/src/app
git commit -m "$(cat <<'EOF'
Move debug screens and fold login UI into InboxScreen.

EOF
)"
```

---

### Task 7: 单测按目录重放

**Files:**

| 现在                        | 之后                                       |
| --------------------------- | ------------------------------------------ |
| `inbox.test.mjs`            | `tests/sessions/inbox.test.mjs`            |
| `transcript.test.mjs`       | `tests/sessions/transcript.test.mjs`       |
| `changes.test.mjs`          | `tests/sessions/changes.test.mjs`          |
| `permission-gate.test.mjs`  | `tests/sessions/permission-gate.test.mjs`  |
| `create-prefs.test.mjs`     | `tests/sessions/create-prefs.test.mjs`     |
| `session-row.test.mjs`      | `tests/sessions/session-row.test.mjs`      |
| `session-cache.test.mjs`    | `tests/sessions/session-cache.test.mjs`    |
| `session-send.test.mjs`     | `tests/sessions/session-send.test.mjs`     |
| `session-nav.test.mjs`      | `tests/sessions/session-nav.test.mjs`      |
| `cloud.test.mjs`            | `tests/cloud/cloud.test.mjs`               |
| `local-cache.test.mjs`      | `tests/cloud/local-cache.test.mjs`         |
| `pending-sends.test.mjs`    | `tests/cloud/pending-sends.test.mjs`       |
| `presentation.test.mjs`     | `tests/presentation/presentation.test.mjs` |
| `i18n.test.mjs`             | `tests/i18n/i18n.test.mjs`                 |
| `tokens.test.mjs`           | `tests/theme/tokens.test.mjs`              |
| `data-runtime.test.mjs`     | `tests/native/data-runtime.test.mjs`       |
| `session-runtime.test.mjs`  | `tests/native/session-runtime.test.mjs`    |
| `session-envelope.test.mjs` | `tests/native/session-envelope.test.mjs`   |
| `create-session.test.mjs`   | `tests/native/create-session.test.mjs`     |
| `archive-session.test.mjs`  | `tests/native/archive-session.test.mjs`    |
| `files-rpc.test.mjs`        | `tests/native/files-rpc.test.mjs`          |
| `local-projects.test.mjs`   | `tests/native/local-projects.test.mjs`     |
| `helpers.mjs`               | `tests/helpers.mjs`（不动）                |

修改根 `package.json`：

```json
"test": "node --experimental-strip-types --experimental-test-module-mocks --test apps/mobile/tests/**/*.test.mjs"
```

每个搬过去的文件按新深度改相对 import（`../src/` → `../../src/`）。`helpers.mjs` 的引用同步改。

删掉 `transcript/types.ts` 再导出文件：所有相对 import 改为 `models/session.ts`。

- [ ] **Step 1: git mv 测试，修正相对路径**

- [ ] **Step 2: 改 `package.json` 的 test glob**

- [ ] **Step 3: `pnpm test` && `pnpm check`**

Expected: 全部收集到且 PASS。少一个文件算失败。

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/tests package.json apps/mobile/src/features/sessions/transcript
git commit -m "$(cat <<'EOF'
Group Node tests by domain and recurse the test glob.

EOF
)"
```

---

### Task 8: 文档与仓库规则

**Files:**

- Modify: `docs/architecture.md` — 「业务页面与 definePage 放在 `src/features`」改为 `src/screens`；示例改为 `export const EnvironmentScreen = definePage(...)`；`present(EnvironmentScreen, …)`。
- Modify: `CLAUDE.md` 与 `AGENTS.md` 同一句：

```text
Routes live in `src/app`, screens in `src/screens`, domain in `src/features`, shapes in `src/models`, cloud protocol in `src/cloud` (auth / catalog / send + kv), shared UI in `src/ui`.
```

补充：features 不引用 screens；打开会话经 `sessionNav` mailbox；`src/screens/` 只有 `*Screen` 文件。

- Modify: 若 `docs/architecture.md` 仍写 `environmentPage`，一并改名。

- [ ] **Step 1: 改三份文档**

- [ ] **Step 2: 最终抽查**

```sh
rg "from '@/features/.*/.*Screen" apps/mobile/src
rg "features/sessions/(detail|files|changes)/" apps/mobile/src
ls apps/mobile/src/screens | grep -v Screen | grep -v debug
pnpm check
pnpm test
```

Expected: screens 根除 `debug/` 外都是 `*Screen.tsx`；无旧 Page 路径。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/architecture.md
git commit -m "$(cat <<'EOF'
Document the screens, models, and cloud domain layout.

EOF
)"
```

---

## Self-review

1. **Spec coverage:** models、cloud domain、kv、mailbox、Screen 导出、Login 折入、DetailBlocks 拆分、status 迁出、tests 分目录、presentation/i18n/theme/verification 不动、文档 — 均有 task。
2. **Placeholder scan:** 无 TBD。toast 与 mailbox 的冲突已在 Task 4 裁定（mailbox 可被 node 直测，toast 在 hook）。
3. **Type names:** Task 5 之后统一 `SessionScreen`；Task 4 允许短暂使用旧 `sessionPage` 导出。
