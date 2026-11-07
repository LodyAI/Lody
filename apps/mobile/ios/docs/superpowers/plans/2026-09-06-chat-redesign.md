# 聊天页重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Lody iOS 的聊天页能完整呈现 coding agent 的转录（工具调用、diff、终端、计划、子任务），并能在手机上直接回答 agent 的权限请求，解掉「会话在手机上死锁」的缺口。

**Architecture:** 三层同时改。data-runtime（跑在离屏 WKWebView 的 TS）把全量投影改成「正文全量 + 工具摘要」的版本化信封，工具 payload 留在 doc 里按需取；RN 侧把转录拆成纯函数聚合 + 无边框文档流渲染，详情与权限走原生 formSheet；键盘与滚动交给系统 API，只保留最小的贴底跟随。

**Tech Stack:** TypeScript / React Native 0.86（新架构）/ Expo Router / loro-crdt 1.15.1 / `@loro-dev/streams-client` / Swift + WKWebView（LodyKit）/ `node --test`（Node 22.13+ 类型剥离）

**Spec:** `docs/superpowers/specs/2026-09-06-chat-redesign-design.md`

## Global Constraints

- **零注释、零 JSDoc**。只有两种情况可以写注释：意外行为的 workaround、非显然的不变量。仓库现有代码就是这个风格，照抄它。
- **不写 Android**，不加 fallback stub。
- **不加新依赖**。需要的能力用 RN 内置件、已装依赖或 LodyKit Swift 解决。
- **单文件 500 行上限，React 组件 300 行上限。**
- **不许 `CODE_SIGNING_ALLOWED=NO`**。模拟器构建也要正常签名。
- **原生 API 只从 `@lody-ios/kit` 导入**。
- **不新建 workspace package**。
- 文案中文，**不用绿色强调色**。强调色用 `colors.accent`，其余用 UIKit 语义色（`usePalette()`）。
- 每个 task 结束跑 `pnpm check`（typecheck + prettier）和 `pnpm test`。**只对改过的文件跑格式化**，不要全仓库跑。
- 测试文件放 `apps/mobile/tests/*.test.mjs`，由根 `pnpm test` 统一执行：`node --experimental-strip-types --experimental-test-module-mocks --test apps/mobile/tests/*.test.mjs`
- 被 `node --test` 直接加载的 `src/` 源文件（如 `aggregate.ts`）**必须用相对路径 + `.ts` 后缀导入**，Node 不解析 `@/` 别名。
- 改动 `modules/lody-kit/data-runtime/` 之后，构建前要跑 `pnpm --filter @lody-ios/mobile native:assets` 重新打包。
- **绝不自动重放写入**（跨 runtime 恢复）。这是仓库硬规则。

---

## File Structure

**新建**

| 文件                                                              | 职责                                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/mobile/src/features/sessions/transcript/aggregate.ts`       | `ItemSummary[]` → 渲染行。纯函数，零 RN 依赖，`node --test` 直跑 |
| `apps/mobile/src/features/sessions/transcript/Transcript.tsx`     | FlatList + 跟随策略                                              |
| `apps/mobile/src/features/sessions/transcript/TurnHeader.tsx`     | 时间 / 已工作 / 复制 / hairline                                  |
| `apps/mobile/src/features/sessions/transcript/UserBubble.tsx`     | 用户气泡                                                         |
| `apps/mobile/src/features/sessions/transcript/AssistantProse.tsx` | 助手正文容器                                                     |
| `apps/mobile/src/features/sessions/transcript/ActivityRow.tsx`    | 聚合后的一行灰字                                                 |
| `apps/mobile/src/features/sessions/detail/itemDetailPage.tsx`     | 活动行详情 sheet                                                 |
| `apps/mobile/src/features/sessions/detail/permissionPage.tsx`     | 权限 sheet                                                       |
| `apps/mobile/src/ui/MarkdownBody.tsx`                             | markdown 渲染，样式集中一处                                      |
| `apps/mobile/modules/lody-kit/data-runtime/project.ts`            | `ItemSummary` 投影 + 脏 entry 缓存 + 信封                        |
| `apps/mobile/modules/lody-kit/ios/Menu/LodyContextMenu.swift`     | `UIContextMenu`                                                  |
| `apps/mobile/modules/lody-kit/src/menu/NativeContextMenu.tsx`     | 上者的 TS 包装                                                   |
| `apps/mobile/tests/transcript.test.mjs`                           | `aggregate.ts` 单测                                              |
| `apps/mobile/tests/session-envelope.test.mjs`                     | 信封校验、乱序丢弃、权限前置校验                                 |

**修改**

| 文件                                                       | 改什么                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/mobile/modules/lody-kit/data-runtime/session.ts`     | `projectHistory` 移交 `project.ts`；两处 emit 出口发新信封；新增 `itemDetail` / `respondPermission` |
| `apps/mobile/modules/lody-kit/ios/Cloud/DataRuntime.swift` | `command()` 放行新方法；载荷超限从静默丢弃改为发 overflow 信封                                      |
| `apps/mobile/modules/lody-kit/src/runtime/LodyKit.ts`      | facade 加 `sessionItemDetail` / `respondSessionPermission`                                          |
| `apps/mobile/modules/lody-kit/src/index.ts`                | 导出上述新 API 与 `NativeContextMenu`                                                               |
| `apps/mobile/src/features/sessions/SessionScreen.tsx`      | 瘦身到 150 行内；接新信封；键盘与滚动；权限自动呈现                                                 |
| `apps/mobile/src/features/sessions/MessageBubble.tsx`      | Task 1 降级，Task 4 删除                                                                            |
| `apps/mobile/tests/session-runtime.test.mjs`               | 补投影与节流断言                                                                                    |

---

## Task 1: ItemSummary 投影与版本化信封

把 `projectHistory` 从「全量压成三字段」改成「正文全量 + 工具摘要 + 稳定 id + rev」，并换掉两处 emit 出口的信封格式。RN 侧同步改接收与校验，`MessageBubble` 降级到能跑即可——**这四处必须同一个 task 落地，否则仓库不可构建。**

**Files:**

- Create: `apps/mobile/modules/lody-kit/data-runtime/project.ts`
- Modify: `apps/mobile/modules/lody-kit/data-runtime/session.ts`（删 `projectHistory`，改两处 emit）
- Modify: `apps/mobile/src/features/sessions/SessionScreen.tsx:37`（`Snapshot` 类型）、`:73-80`（接收校验）
- Modify: `apps/mobile/src/features/sessions/MessageBubble.tsx`（降级）
- Test: `apps/mobile/tests/session-runtime.test.mjs`（扩写）

**Interfaces:**

- Consumes: `LoroDoc`（`loro-crdt/base64`）、现有 `active` state 的 `emit`
- Produces:
  - `projectSession(doc: LoroDoc, status: string, reason?: string): Envelope`
  - `type ItemSummary`、`type EntrySummary`、`type Envelope`（下方定义，Task 3/4/6/7/8 都依赖这些名字和字段）

```ts
export type ItemSummary =
  | { itemId: string; rev: number; type: 'text'; text: string }
  | { itemId: string; rev: number; type: 'thought'; text: string }
  | {
      itemId: string;
      rev: number;
      type: 'tool_call';
      kind: string;
      title: string;
      status: string;
      path?: string;
      added?: number;
      removed?: number;
      hasDetail: boolean;
      permission?: { requestId: string; pending: boolean };
    }
  | {
      itemId: string;
      rev: number;
      type: 'plan';
      entries: { content: string; status: string; priority?: string }[];
    }
  | {
      itemId: string;
      rev: number;
      type: 'subagent_task';
      taskId: string;
      status: string;
      actor?: string;
      description?: string;
    }
  | { itemId: string; rev: number; type: string };

export type EntrySummary = {
  id: string;
  rev: number;
  role: string;
  status: string;
  finished: boolean;
  timestamp?: string;
  startedAt?: number;
  endedAt?: number;
  permissionWaitMs?: number;
  items: ItemSummary[];
};

export type Envelope = {
  v: 1;
  status: string;
  reason?: string;
  revision: number;
  awaitingUserSince?: number;
  entries: EntrySummary[];
};
```

- [ ] **Step 1: 写失败的测试 —— 稳定 itemId 与工具摘要**

追加到 `apps/mobile/tests/session-runtime.test.mjs` 末尾（在 `delete globalThis.__sessionClient;` 之前的那个 test 之后，作为新的 `test(...)` 块）：

```js
test('projection carries stable item ids, tool summaries, and diff counts', async () => {
  const bundle = await build({
    entryPoints: [
      new URL('../modules/lody-kit/data-runtime/project.ts', import.meta.url)
        .pathname,
    ],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    external: ['loro-crdt/base64'],
  });
  const mod = await import(
    'data:text/javascript;base64,' +
      Buffer.from(bundle.outputFiles[0].text).toString('base64')
  );

  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e1');
  entry.set('role', 'assistant');
  entry.set('finished', false);
  const items = entry.setContainer('items', new LoroList());

  const prose = items.pushContainer(new LoroMap());
  prose.set('type', 'text');
  prose.setContainer('text', new LoroText()).insert(0, '看了一眼 auth.ts');

  const call = items.pushContainer(new LoroMap());
  call.set('type', 'tool_call');
  call.set('toolCallId', 'tc_1');
  call.set('kind', 'edit');
  call.set('title', 'Edit src/auth.ts');
  call.set('status', 'completed');
  call.set('content', [
    {
      type: 'diff',
      path: 'src/auth.ts',
      oldText: 'a\nb\nc\n',
      newText: 'a\nB\nc\nd\n',
    },
  ]);
  doc.commit();

  const first = mod.projectSession(doc, 'live');
  assert.equal(first.v, 1);
  assert.equal(first.entries.length, 1);

  const [textItem, toolItem] = first.entries[0].items;
  assert.equal(textItem.type, 'text');
  assert.equal(textItem.text, '看了一眼 auth.ts');
  assert.match(textItem.itemId, /^\d+:\d+$/);

  assert.equal(toolItem.itemId, 'tc_1');
  assert.equal(toolItem.kind, 'edit');
  assert.equal(toolItem.path, 'src/auth.ts');
  assert.equal(toolItem.added, 2);
  assert.equal(toolItem.removed, 1);
  assert.equal(toolItem.hasDetail, true);
  assert.equal(toolItem.permission, undefined);

  const idBefore = textItem.itemId;
  prose.get('text').insert(11, '，超时来自 fetch');
  doc.commit();
  const second = mod.projectSession(doc, 'live');
  assert.equal(second.entries[0].items[0].itemId, idBefore);
  assert.ok(second.entries[0].items[0].rev > textItem.rev);
  assert.equal(second.entries[0].items[1].rev, toolItem.rev);
  assert.ok(second.revision > first.revision);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL，`Cannot find module .../data-runtime/project.ts`

- [ ] **Step 3: 实现 `project.ts`**

Create `apps/mobile/modules/lody-kit/data-runtime/project.ts`：

```ts
import type { LoroDoc, LoroList, LoroMap } from 'loro-crdt/base64';

export type ItemSummary = /* 见上方 Interfaces 块，原样抄进来 */ never;
export type EntrySummary = /* 同上 */ never;
export type Envelope = /* 同上 */ never;

const DETAIL_TYPES = new Set(['tool_call', 'subagent_task']);
let revision = 0;
const revs = new Map<string, { rev: number; fingerprint: string }>();

function bump(key: string, fingerprint: string) {
  const previous = revs.get(key);
  if (previous && previous.fingerprint === fingerprint) return previous.rev;
  const rev = (previous?.rev ?? 0) + 1;
  revs.set(key, { rev, fingerprint });
  return rev;
}

export function resetProjection() {
  revision = 0;
  revs.clear();
}

function countDiff(content: unknown) {
  if (!Array.isArray(content)) return undefined;
  let added = 0,
    removed = 0,
    path: string | undefined;
  for (const block of content) {
    if (!block || block.type !== 'diff') continue;
    path ??= typeof block.path === 'string' ? block.path : undefined;
    const before = String(block.oldText ?? '').split('\n');
    const after = String(block.newText ?? '').split('\n');
    const shared = new Set(before);
    for (const line of after) if (!shared.has(line)) added += 1;
    const target = new Set(after);
    for (const line of before) if (!target.has(line)) removed += 1;
  }
  return path === undefined && added === 0 && removed === 0
    ? undefined
    : { path, added, removed };
}

function summarizeItem(
  raw: any,
  entryId: string,
  identity: string,
): ItemSummary {
  const type = String(raw?.type ?? 'unknown');
  const itemId =
    type === 'tool_call' && typeof raw.toolCallId === 'string'
      ? raw.toolCallId
      : identity;
  const key = `${entryId}/${itemId}`;

  if (type === 'text' || type === 'thought') {
    const text = typeof raw.text === 'string' ? raw.text : '';
    return { itemId, rev: bump(key, text), type, text } as ItemSummary;
  }

  if (type === 'tool_call') {
    const diff = countDiff(raw.content);
    const permission = raw.permissionRequest
      ? {
          requestId: String(raw.permissionRequest.requestId ?? ''),
          pending: raw.permissionRequest.outcome == null,
        }
      : undefined;
    const summary = {
      itemId,
      rev: 0,
      type,
      kind: String(raw.kind ?? 'other'),
      title: String(raw.title ?? raw.toolName ?? ''),
      status: String(raw.status ?? 'pending'),
      path: diff?.path,
      added: diff?.added,
      removed: diff?.removed,
      hasDetail: Array.isArray(raw.content) ? raw.content.length > 0 : false,
      permission,
    };
    summary.rev = bump(key, JSON.stringify(summary));
    return summary as ItemSummary;
  }

  if (type === 'plan') {
    const entries = (Array.isArray(raw.entries) ? raw.entries : []).map(
      (e: any) => ({
        content: String(e?.content ?? ''),
        status: String(e?.status ?? 'pending'),
        priority: e?.priority == null ? undefined : String(e.priority),
      }),
    );
    return {
      itemId,
      rev: bump(key, JSON.stringify(entries)),
      type,
      entries,
    } as ItemSummary;
  }

  if (type === 'subagent_task') {
    const summary = {
      itemId,
      rev: 0,
      type,
      taskId: String(raw.taskId ?? itemId),
      status: String(raw.status ?? 'pending'),
      actor: raw.actor == null ? undefined : String(raw.actor),
      description:
        raw.description == null ? undefined : String(raw.description),
    };
    summary.rev = bump(key, JSON.stringify(summary));
    return summary as ItemSummary;
  }

  return { itemId, rev: bump(key, type), type } as ItemSummary;
}
```

同一文件继续，投影入口。注意**必须遍历 `LoroList` 而不是 `doc.toJSON()`**，否则 `getIdAt` 拿不到；同时保留现有的因果排序：

```ts
function identityAt(list: LoroList, index: number) {
  const id = list.getIdAt(index);
  return id ? `${id.peer}:${id.counter}` : `idx:${index}`;
}

export function projectSession(
  doc: LoroDoc,
  status: string,
  reason?: string,
): Envelope {
  const history = doc.getList('history') as LoroList;
  const raw = history.toJSON() as any[];
  const summarized = raw.map((entry: any, index: number) => {
    const container = history.get(index) as LoroMap | undefined;
    const items =
      container && typeof (container as any).get === 'function'
        ? ((container as any).get('items') as LoroList | undefined)
        : undefined;
    const list = Array.isArray(entry?.items) ? entry.items : [];
    return {
      id: String(entry?.id ?? identityAt(history, index)),
      role: String(entry?.role ?? 'assistant'),
      status: entry?.status ?? (entry?.read ? 'seen' : 'pending'),
      finished: entry?.finished === true,
      timestamp: entry?.timestamp,
      startedAt: entry?.startedAt,
      endedAt: entry?.endedAt,
      permissionWaitMs: entry?.permissionWaitMs,
      userTurnId: entry?.userTurnId,
      items: list.map((item: any, i: number) =>
        summarizeItem(
          item,
          String(entry?.id ?? index),
          items && typeof items.getIdAt === 'function'
            ? identityAt(items, i)
            : `idx:${index}:${i}`,
        ),
      ),
    };
  });

  const userIds = new Set(
    summarized.filter((e) => e.role === 'user').map((e) => e.id),
  );
  const replies = new Map<string, typeof summarized>();
  for (const entry of summarized)
    if (entry.role === 'assistant' && userIds.has(entry.userTurnId)) {
      const group = replies.get(entry.userTurnId) ?? [];
      group.push(entry);
      replies.set(entry.userTurnId, group);
    }
  const ordered = summarized.flatMap((entry) =>
    entry.role === 'assistant' && userIds.has(entry.userTurnId)
      ? []
      : [
          entry,
          ...(entry.role === 'user' ? (replies.get(entry.id) ?? []) : []),
        ],
  );

  revision += 1;
  const session = doc.toJSON().session;
  return {
    v: 1,
    status,
    reason,
    revision,
    awaitingUserSince:
      typeof session?.awaitingUserSince === 'number'
        ? session.awaitingUserSince
        : undefined,
    entries: ordered.map(({ userTurnId, ...entry }) => ({
      ...entry,
      rev: bump(
        `entry/${entry.id}`,
        entry.items.map((i) => `${i.itemId}:${i.rev}`).join(',') +
          `|${entry.status}|${entry.finished}`,
      ),
    })) as EntrySummary[],
  };
}
```

把 Interfaces 块里的三个类型定义原样替换掉文件顶部的 `never` 占位。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS，包括原有的 `session-runtime` 测试

- [ ] **Step 5: 换掉 `session.ts` 的两处 emit 出口**

`apps/mobile/modules/lody-kit/data-runtime/session.ts`：

1. 删掉整个 `projectHistory` 函数（`session.ts:25-61`），顶部改为 `import { projectSession, resetProjection } from './project';`
2. `openSession` 里的 `event()` 闭包（约 `:106-117`）改成 `session: JSON.stringify(projectSession(state.doc, status, reason))`
3. `sendTurn` 里那处 `state.emit`（约 `:260-266`）同样改
4. `openSession` 开头、`active = state` 之后加一行 `resetProjection()`
5. 现有测试里 `runtime.projectHistory(misordered)` 那段断言改成 `runtime.projectSession(misordered, 'live').entries`，并在 `index.ts` 导出 `projectSession`（替换原来导出的 `projectHistory`）

- [ ] **Step 6: RN 侧接新信封 + `MessageBubble` 降级**

`SessionScreen.tsx`：

```tsx
type Snapshot = {
  status: string;
  reason?: string;
  revision: number;
  awaitingUserSince?: number;
  entries: EntrySummary[];
};
```

接收处（原 `:73-80`）改成——`generation` 直接读 `event.generation`，Swift 已经在每次 emit 里 merge 了 `status()`：

```tsx
const generation = useRef(-1);
const revision = useRef(-1);
// ...
if (event.sessionId === session.id && event.session) {
  try {
    const data = JSON.parse(event.session);
    if (data.v !== 1) return;
    if (event.generation < generation.current) return;
    if (event.generation > generation.current) {
      generation.current = event.generation;
      revision.current = -1;
    }
    if (data.overflow) {
      setOverflow(true);
      return;
    }
    if (data.revision <= revision.current) return;
    revision.current = data.revision;
    setOverflow(false);
    setSnapshot(data);
  } catch {
    setSnapshot((old) => ({ ...old, status: 'offline' }));
  }
}
```

`MessageBubble.tsx` 降级：`message.items` 现在是 `ItemSummary[]`。`text` / `thought` 照旧渲染，其余一律渲染成一行 `colors.secondaryLabel` 的灰字，内容取 `title || type`。**删掉「完整内容可在电脑上查看」那段文案和外框。** 这是过渡形态，Task 4 会整个替换掉它。

`Snapshot.messages` 改名为 `entries` 的引用点：`SessionScreen.tsx:95-96`、`:200`。

- [ ] **Step 7: Swift 侧超限从静默丢弃改为 overflow 信封**

`DataRuntime.swift:120-122` 现在是：

```swift
guard let id = body["sessionId"] as? String, id == sessionId,
      let session = body["session"] as? String, session.utf8.count <= 12 * 1024 * 1024 else { return }
emit(status().merging(["sessionId": id, "session": session], uniquingKeysWith: { _, new in new }))
```

超限时 `return` 掉整帧，RN 完全不知道发生过。改成超限时发一个 overflow 信封，让 RN 能保留上一份快照并提示：

```swift
guard let id = body["sessionId"] as? String, id == sessionId,
      let session = body["session"] as? String else { return }
let payload = session.utf8.count <= 12 * 1024 * 1024
  ? session
  : #"{"v":1,"overflow":true}"#
emit(status().merging(["sessionId": id, "session": payload], uniquingKeysWith: { _, new in new }))
```

RN 侧 Step 6 的 `if (data.overflow)` 分支已经准备好接它：**保留 `snapshot` 不动**，只置 `overflow` state，由 Task 4 在转录顶部渲染一行「同步已停止 · 内容可能不是最新」。

- [ ] **Step 8: 验证**

```bash
pnpm --filter @lody-ios/mobile native:assets
pnpm check && pnpm test && pnpm bundle
pnpm --filter @lody-ios/mobile ios
```

Expected: 全部通过（改了 Swift，需要模拟器构建）

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/modules/lody-kit/data-runtime apps/mobile/src/features/sessions apps/mobile/tests
git commit -m "feat(chat): 摘要投影与版本化信封"
```

---

## Task 2: 脏 entry 缓存与分级节流

投影现在每次 doc 更新都重跑全量。加缓存让未变 entry 复用上次结果，加分级节流让正文追加走尾沿、状态变化立即刷新。

**Files:**

- Modify: `apps/mobile/modules/lody-kit/data-runtime/project.ts`
- Modify: `apps/mobile/modules/lody-kit/data-runtime/session.ts`
- Test: `apps/mobile/tests/session-runtime.test.mjs`

**Interfaces:**

- Consumes: Task 1 的 `projectSession` / `resetProjection`
- Produces: `scheduleEmit(state, status, reason?, immediate?: boolean): void`（`session.ts` 内部，不导出）

- [ ] **Step 1: 写失败的测试**

追加到 `apps/mobile/tests/session-runtime.test.mjs`：

```js
test('unchanged entries keep their summary objects; prose is coalesced, status is not', async () => {
  const { projectSession, resetProjection } = await loadProject();
  resetProjection();
  const doc = new LoroDoc();
  const first = doc.getList('history').pushContainer(new LoroMap());
  first.set('id', 'e1');
  first.set('role', 'user');
  const second = doc.getList('history').pushContainer(new LoroMap());
  second.set('id', 'e2');
  second.set('role', 'assistant');
  const items = second.setContainer('items', new LoroList());
  const prose = items.pushContainer(new LoroMap());
  prose.set('type', 'text');
  prose.setContainer('text', new LoroText()).insert(0, 'hi');
  doc.commit();

  const a = projectSession(doc, 'live');
  prose.get('text').insert(2, ' there');
  doc.commit();
  const b = projectSession(doc, 'live');

  assert.equal(a.entries[0].rev, b.entries[0].rev);
  assert.ok(b.entries[1].rev > a.entries[1].rev);
});
```

把 Task 1 Step 1 里那段 esbuild 加载逻辑抽成文件顶部的 `loadProject()` 辅助函数，两个 test 共用。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— `a.entries[0].rev` 与 `b.entries[0].rev` 不等（每次调用都 bump）

- [ ] **Step 3: 让 `bump` 真正做到「指纹不变就不涨」**

Task 1 的 `bump` 已经比对指纹了，失败的原因在 `projectSession` 里 entry 的指纹包含了 `revision` 之外的易变量。检查并修正：entry 指纹只由「其 items 的 `itemId:rev` 序列 + status + finished」构成，**不含 timestamp、不含 revision**。同时给 entry 级加短路——指纹未变时直接复用上次的 `EntrySummary` 对象，跳过整个 `items.map`：

```ts
const entryCache = new Map<
  string,
  { fingerprint: string; value: EntrySummary }
>();
```

在 `summarized` 的 map 里，先算一个廉价的 entry 指纹（`JSON.stringify(entry)` 即可，`toJSON()` 已经拿到了），命中缓存就直接返回缓存值，不进 `summarizeItem`。`resetProjection()` 里一并 `entryCache.clear()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: 加分级节流**

`session.ts`：把所有 `emit` 调用点收敛到一个 `scheduleEmit`。

```ts
let pending: ReturnType<typeof setTimeout> | undefined;
let firstQueuedAt = 0;

function scheduleEmit(
  state: any,
  status: string,
  reason?: string,
  immediate = false,
) {
  const flush = () => {
    pending = undefined;
    firstQueuedAt = 0;
    if (active !== state) return;
    state.emit({
      type: 'session',
      sessionId: state.id,
      session: JSON.stringify(projectSession(state.doc, status, reason)),
    });
  };
  if (immediate) {
    if (pending) clearTimeout(pending);
    flush();
    return;
  }
  const now = Date.now();
  if (!firstQueuedAt) firstQueuedAt = now;
  if (now - firstQueuedAt >= 200) {
    if (pending) clearTimeout(pending);
    flush();
    return;
  }
  if (pending) clearTimeout(pending);
  pending = setTimeout(flush, 100);
}
```

`immediate = true` 的三种情形：状态变化（`syncing` / `live` / `offline` 之间切换）、有 entry 的 `finished` 从 false 翻 true、`awaitingUserSince` 从无到有。判定放在调用点：投影结果与上一次比对这三个信号。`closeSession()` 里 `clearTimeout(pending)`。

- [ ] **Step 6: 验证并提交**

```bash
pnpm --filter @lody-ios/mobile native:assets
pnpm check && pnpm test
git add apps/mobile/modules/lody-kit/data-runtime apps/mobile/tests
git commit -m "perf(chat): 脏 entry 缓存与分级节流"
```

---

## Task 3: 活动行聚合（纯函数 + 单测）

把 `ItemSummary[]` 折成渲染行。这是本轮唯一值得写细单测的展示逻辑。

**Files:**

- Create: `apps/mobile/src/features/sessions/transcript/aggregate.ts`
- Test: `apps/mobile/tests/transcript.test.mjs`

**Interfaces:**

- Consumes: Task 1 的 `ItemSummary`（类型在 data-runtime 里，RN 侧重新声明一份结构相同的，避免跨包 import 原生构建产物）
- Produces:

```ts
export type Row =
  | { kind: 'prose'; itemId: string; rev: number; text: string }
  | { kind: 'thought'; itemId: string; rev: number; text: string }
  | { kind: 'plan'; itemId: string; rev: number; entries: PlanEntry[] }
  | { kind: 'task'; itemId: string; rev: number; label: string; status: string }
  | {
      kind: 'activity';
      itemId: string;
      rev: number;
      symbol: string;
      label: string;
      running: boolean;
      failed: boolean;
      pendingPermission?: string;
      members: string[];
    };

export function aggregate(items: ItemSummary[]): Row[];
```

`activity.itemId` 取该组第一个成员的 id，`rev` 取组内 rev 之和（组内任一变化则整行变），`members` 是组内全部 itemId（详情 sheet 用它决定展示哪些）。

- [ ] **Step 1: 写失败的测试**

Create `apps/mobile/tests/transcript.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../src/features/sessions/transcript/aggregate.ts';

const tool = (id, kind, extra = {}) => ({
  itemId: id,
  rev: 1,
  type: 'tool_call',
  kind,
  title: '',
  status: 'completed',
  hasDetail: true,
  ...extra,
});

test('连续同类工具合成一行，被正文打断则起新行', () => {
  const rows = aggregate([
    { itemId: 't1', rev: 1, type: 'text', text: '开始' },
    tool('a', 'read'),
    tool('b', 'search'),
    { itemId: 't2', rev: 1, type: 'text', text: '继续' },
    tool('c', 'read'),
  ]);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['prose', 'activity', 'prose', 'activity'],
  );
  assert.deepEqual(rows[1].members, ['a', 'b']);
  assert.equal(rows[1].label, '读取了文件');
  assert.deepEqual(rows[3].members, ['c']);
});

test('单个 edit 带 path 与增删行数，多个合并只给类别', () => {
  const one = aggregate([
    tool('a', 'edit', { path: 'src/auth.ts', added: 12, removed: 3 }),
  ]);
  assert.equal(one[0].label, '编辑了 src/auth.ts +12 −3');

  const many = aggregate([
    tool('a', 'edit', { path: 'src/auth.ts', added: 12, removed: 3 }),
    tool('b', 'write', { path: 'src/x.ts', added: 1, removed: 0 }),
  ]);
  assert.equal(many[0].label, '编辑了文件');
});

test('混合 kind 最多列三类，超出用「等」', () => {
  const rows = aggregate([
    tool('a', 'read'),
    tool('b', 'execute'),
    tool('c', 'fetch'),
    tool('d', 'mcp'),
  ]);
  assert.equal(rows[0].label, '读取了文件、执行了命令、访问了网络等');
  assert.equal(rows[0].symbol, 'wrench.and.screwdriver');
});

test('运行中与失败各自标记，待授权透出 requestId', () => {
  const rows = aggregate([
    tool('a', 'execute', { status: 'in_progress' }),
    { itemId: 'x', rev: 1, type: 'text', text: '—' },
    tool('b', 'execute', { status: 'failed' }),
    { itemId: 'y', rev: 1, type: 'text', text: '—' },
    tool('c', 'execute', {
      status: 'pending',
      permission: { requestId: 'r1', pending: true },
    }),
  ]);
  assert.equal(rows[0].running, true);
  assert.equal(rows[2].failed, true);
  assert.equal(rows[2].label, '失败：执行了命令');
  assert.equal(rows[4].pendingPermission, 'r1');
});

test('plan 与 subagent_task 不参与聚合', () => {
  const rows = aggregate([
    tool('a', 'read'),
    { itemId: 'p', rev: 1, type: 'plan', entries: [] },
    tool('b', 'read'),
  ]);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['activity', 'plan', 'activity'],
  );
});

test('未知类型渲染成中性活动行，不带占位文案', () => {
  const rows = aggregate([{ itemId: 'z', rev: 1, type: 'worktree_script' }]);
  assert.equal(rows[0].kind, 'activity');
  assert.equal(rows[0].label, '调用了工具');
  assert.equal(rows[0].members.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL，`Cannot find module .../transcript/aggregate.ts`

- [ ] **Step 3: 实现 `aggregate.ts`**

Create `apps/mobile/src/features/sessions/transcript/aggregate.ts`。零 RN 依赖。kind → 类别与措辞的映射：

```ts
const CATEGORIES = {
  read: { symbol: 'doc.text.magnifyingglass', label: '读取了文件' },
  edit: { symbol: 'square.and.pencil', label: '编辑了文件' },
  execute: { symbol: 'terminal', label: '执行了命令' },
  fetch: { symbol: 'globe', label: '访问了网络' },
  tool: { symbol: 'wrench.and.screwdriver', label: '调用了工具' },
} as const;

const KIND_TO_CATEGORY: Record<string, keyof typeof CATEGORIES> = {
  read: 'read',
  search: 'read',
  edit: 'edit',
  write: 'edit',
  move: 'edit',
  delete: 'edit',
  execute: 'execute',
  bash: 'execute',
  fetch: 'fetch',
  mcp: 'tool',
  other: 'tool',
  computer: 'tool',
  think: 'tool',
  switch_mode: 'tool',
};
```

聚合规则：遍历 `items`，`tool_call` 与未知类型进入当前组，其余类型（`text` / `thought` / `plan` / `subagent_task`）先冲刷当前组再各自成行。组内按出现顺序去重收集类别；单成员且类别为 `edit` 且有 `path` 时标签用 `编辑了 ${path} +${added} −${removed}`（`added`/`removed` 为 0 或缺失时省略对应片段）；多类别时用 `、` 连接前三个，超过三个末尾加 `等`；组内符号取「唯一类别的符号」，多类别取 `wrench.and.screwdriver`。

`running` = 组内任一 `status === 'in_progress'`；`failed` = 组内任一 `status === 'failed'`，此时标签前缀 `失败：` 且不再用 edit 的详细形式；`pendingPermission` = 组内第一个 `permission?.pending === true` 的 `requestId`。

注意 `−` 是 U+2212 减号，不是连字符，与 spec 一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: 6 个新 test 全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/sessions/transcript apps/mobile/tests/transcript.test.mjs
git commit -m "feat(chat): 活动行聚合"
```

---

## Task 4: 转录渲染

把 `MessageBubble` 换成安静文档流：用户气泡、助手全宽正文、灰字活动行、轮次头。

**Files:**

- Create: `apps/mobile/src/ui/MarkdownBody.tsx`
- Create: `apps/mobile/src/features/sessions/transcript/{Transcript,TurnHeader,UserBubble,AssistantProse,ActivityRow}.tsx`
- Delete: `apps/mobile/src/features/sessions/MessageBubble.tsx`
- Modify: `apps/mobile/src/features/sessions/SessionScreen.tsx`

**Interfaces:**

- Consumes: Task 3 的 `aggregate` / `Row`，Task 1 的 `EntrySummary`
- Produces: `<Transcript entries listRef onActivityPress />`，其中 `onActivityPress: (entryId: string, row: Row) => void`（Task 7 接上详情 sheet）

- [ ] **Step 1: 抽出 `MarkdownBody`**

把 `MessageBubble.tsx` 里那整块 `react-native-markdown-display` 的 `style` 对象和 `rules`（含 `openLink` 与 image 占位）原样搬到 `apps/mobile/src/ui/MarkdownBody.tsx`，导出 `export function MarkdownBody({ children }: { children: string })`。样式值不改，只换位置——这一步是纯搬运，视觉零变化。

- [ ] **Step 2: 写四个展示组件**

`UserBubble.tsx`：`alignSelf: 'flex-end'`、`maxWidth: '80%'`、`backgroundColor: colors.fill`、`borderRadius: 19`、`borderCurve: 'continuous'`、`paddingHorizontal: 13`、`paddingVertical: 8`。文本用 `AppText variant="body"`，`selectable`。

`TurnHeader.tsx`：接 `{ timestamp, startedAt, endedAt, permissionWaitMs, onCopy }`。第一行右对齐时间 + 复制按钮（`NativeSymbolButton` symbol `doc.on.doc`，44pt 触控区）；第二行「已工作 N 分 M 秒」，由 `endedAt - Date.parse(timestamp) - (permissionWaitMs ?? 0)` 计算，`endedAt` 缺失时显示「进行中」；下方 `borderBottomWidth: StyleSheet.hairlineWidth`、`borderBottomColor: colors.separator`。全部用 `AppText variant="meta"`。

`AssistantProse.tsx`：全宽，无背景无边框，内部就是 `<MarkdownBody>`。

`ActivityRow.tsx`：`flexDirection: 'row'`、`minHeight: 44`、`gap: 9`。左侧 SF Symbol（复用 `NativeSymbolButton` 的非 `prominent` 形态，`tint={colors.secondaryLabel}`）、中间 `AppText variant="meta"` 标签、右侧 chevron。`running` 时标签后接一个 `ActivityIndicator size="small"`；`failed` 时标签色改 `colors.danger`；`pendingPermission` 存在时标签色改 warning 并把文案换成「等待你的批准」。`accessibilityRole="button"`，`accessibilityLabel` 用标签全文。

- [ ] **Step 3: 写 `Transcript.tsx`**

`FlatList`，`data` 是把 `entries` 展平后的渲染项数组：每个 entry 产出 `[轮次头?, ...aggregate(entry.items) 的行]`，`role === 'user'` 的 entry 直接产出一个 `UserBubble` 行且不带轮次头。`keyExtractor` 用 `${entryId}:${itemId}`。

`renderItem` 按 `kind` 分派到上面四个组件。用 `memo` 包每个行组件，比较函数只看 `(itemId, rev)`。

`contentContainerStyle`：`paddingHorizontal: 16`、`paddingTop: 16`、`paddingBottom: 24`、`gap: 16`。

`contentInsetAdjustmentBehavior="automatic"`、`keyboardDismissMode="interactive"`、`keyboardShouldPersistTaps="handled"` 保留。

- [ ] **Step 4: 接进 `SessionScreen` 并删掉 `MessageBubble`**

`SessionScreen` 的 `FlatList` 整块换成 `<Transcript>`。删除 `MessageBubble.tsx`。

两个状态条一并落地（spec 的「体面加载态」与「不静默的超限降级」）：

- **加载态**：`status !== 'live' && entries.length === 0` 时，不用居中 spinner，渲染三条骨架行——一条 70% 宽、一条 90% 宽、一条 40% 宽的 `colors.fill` 圆角块，高度 16、间距 12，**并保留 header 的会话标题**。`accessibilityLabel="正在取回对话"`。
- **overflow 条**：Task 1 的 `overflow` state 为真时，转录顶部固定一行 warning 色文字「同步已停止 · 内容可能不是最新」，不清空已有内容。

空状态（`status === 'live' && entries.length === 0`）保留现有文案，移进 `Transcript` 的 props。

`SessionScreen` 此时应在 200 行内；若仍超，把 `submit` 与订阅逻辑抽成 `useSessionRuntime(session)` hook 放在 `SessionScreen` 同目录。

- [ ] **Step 5: 验证**

```bash
pnpm check && pnpm test && pnpm bundle
```

- [ ] **Step 6: Commit**

```bash
git add -A apps/mobile/src
git commit -m "feat(chat): 安静文档流转录"
```

---

## Task 5: 键盘与滚动

删掉 `KeyboardAvoidingView`，composer 交给 `InputAccessoryView`；简化贴底跟随。

**Files:**

- Modify: `apps/mobile/src/features/sessions/SessionScreen.tsx`
- Modify: `apps/mobile/src/features/sessions/transcript/Transcript.tsx`

**Interfaces:**

- Consumes: Task 4 的 `<Transcript>`
- Produces: 无新接口

- [ ] **Step 1: composer 移入 `InputAccessoryView`**

`import { InputAccessoryView } from 'react-native';`。给 composer 的 `TextInput`（`ui/Composer.tsx` 里那个）加 `inputAccessoryViewID`，`SessionScreen` 里用同一个 id 包住 composer 与其上方的状态文案。删掉 `KeyboardAvoidingView` 及 `useSafeAreaInsets` 的 `paddingBottom` 计算——`InputAccessoryView` 自带安全区处理。

`Composer.tsx` 需要新增可选 prop `inputAccessoryViewID?: string` 并透传给 `TextInput`。

- [ ] **Step 2: 简化跟随**

`Transcript.tsx` 里：

```tsx
const nearBottom = useRef(true);
// ...
maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
onScroll={({ nativeEvent: e }) => {
  nearBottom.current =
    e.contentSize.height - e.contentOffset.y - e.layoutMeasurement.height < 120;
}}
scrollEventThrottle={100}
onContentSizeChange={() => {
  if (nearBottom.current)
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
}}
```

删掉 `SessionScreen` 里的 `showJump` state、跳转按钮、`viewportHeight` / `contentHeight` ref、`following` ref 和 `scrollToLatest`。

- [ ] **Step 3: 模拟器实测**

```bash
pnpm --filter @lody-ios/mobile ios
```

在真实账号的一个会话里确认：

- 键盘弹出、收起、interactive dismiss 期间 composer 无跳变
- 流式回复时贴底自动跟随
- 手动上滑后不被拽回底部

**如果 `maintainVisibleContentPosition` 与 `scrollToEnd` 打架导致跳动**，去掉 `maintainVisibleContentPosition` 只留 `nearBottom` 跟随；仍不行则改用 `inverted` 列表并把轮次头顺序反转——这是 spec 里写明的退路，改了要回写 spec。

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src
git commit -m "feat(chat): 键盘与滚动交给系统 API"
```

---

## Task 6: `sessionItemDetail` 按需通道

新增从 RN 到 data-runtime 的按需取详情通道。Swift 侧复用现有 `command()`，只需放行新方法名。

**Files:**

- Modify: `apps/mobile/modules/lody-kit/data-runtime/session.ts`
- Modify: `apps/mobile/modules/lody-kit/data-runtime/index.ts`
- Modify: `apps/mobile/modules/lody-kit/ios/Cloud/DataRuntime.swift:157-160`
- Modify: `apps/mobile/modules/lody-kit/ios/LodyKitModule.swift`
- Modify: `apps/mobile/modules/lody-kit/src/runtime/LodyKit.ts`、`src/index.ts`
- Test: `apps/mobile/tests/session-runtime.test.mjs`

**Interfaces:**

- Produces:

```ts
export function sessionItemDetail(payload: string): Promise<string>;
// project.ts 追加导出，供 session.ts 的 itemDetail 复用，不要重写一份：
export function identityAt(list: LoroList, index: number): string;
export function itemRev(entryId: string, itemId: string): number;

type DetailRequest = {
  sessionId: string;
  entryId: string;
  itemId: string;
  cursor?: string;
};
type DetailResponse = {
  itemId: string;
  rev: number;
  blocks: {
    type: string;
    path?: string;
    oldText?: string;
    newText?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    output?: string;
    exitStatus?: { exitCode?: number | null; signal?: string | null };
  }[];
  rawInput?: unknown;
  rawOutput?: unknown;
  options?: { optionId: string; name: string; kind: string }[];
  outcome?: unknown;
  truncated: boolean;
  nextCursor?: string;
};
```

- [ ] **Step 1: 写失败的测试**

追加到 `apps/mobile/tests/session-runtime.test.mjs`。这个 test 需要一个已 `openSession` 的 runtime，照抄文件里第一个 test 的 `globalThis.__sessionClient` 假实现与 `openSession` 调用建立环境，然后：

```js
test('itemDetail 按需取回 blocks，超限分页，缺失不抛错', async () => {
  const entry = server.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e9');
  entry.set('role', 'assistant');
  const items = entry.setContainer('items', new LoroList());
  const call = items.pushContainer(new LoroMap());
  call.set('type', 'tool_call');
  call.set('toolCallId', 'tc_9');
  call.set('kind', 'execute');
  call.set('status', 'completed');
  call.set('content', [
    { type: 'terminal_command', command: 'pnpm', args: ['test'], cwd: '/w' },
    { type: 'terminal_output', output: 'ok\n', stream: 'combined' },
  ]);
  server.commit();
  await pushUpdate();

  const detail = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e9',
    itemId: 'tc_9',
  });
  assert.equal(detail.itemId, 'tc_9');
  assert.equal(detail.blocks.length, 2);
  assert.equal(detail.blocks[0].command, 'pnpm');
  assert.equal(detail.truncated, false);
  assert.equal(detail.nextCursor, undefined);
  assert.ok(detail.rev > 0);

  call.set('content', [
    { type: 'terminal_output', output: 'x'.repeat(400 * 1024) },
    { type: 'terminal_output', output: 'y'.repeat(400 * 1024) },
  ]);
  server.commit();
  await pushUpdate();

  const page1 = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e9',
    itemId: 'tc_9',
  });
  assert.equal(page1.truncated, true);
  assert.equal(page1.blocks.length, 1);
  assert.ok(page1.nextCursor);

  const page2 = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e9',
    itemId: 'tc_9',
    cursor: page1.nextCursor,
  });
  assert.equal(page2.blocks.length, 1);
  assert.equal(page2.truncated, false);

  const missing = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e9',
    itemId: 'nope',
  });
  assert.deepEqual(missing.blocks, []);
  assert.equal(missing.truncated, false);

  await assert.rejects(
    runtime.itemDetail({ sessionId: 'other', entryId: 'e9', itemId: 'tc_9' }),
    /session_not_ready/,
  );
});
```

`pushUpdate()` 是把 `server` 的增量经假 client 推给 runtime 并等一次 emit 的辅助函数——文件里第一个 test 已有等价逻辑（`nextLive()` + `sessionRead(live({ body: frame(update) }))`），抽成共享 helper 再用。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL —— `runtime.itemDetail is not a function`

- [ ] **Step 3: 实现**

`session.ts` 新增 `itemDetail(args: DetailRequest): Promise<DetailResponse>`。校验 `args.sessionId === active?.id`，否则抛 `session_not_ready`（与 `sendTurn` 一致）。从 `active.doc` 里按 `entryId` 找 entry、按 `itemId` 找 item（`tool_call` 比 `toolCallId`，其余比 `getIdAt` 身份，逻辑与 `project.ts` 的 `identityAt` 保持一致——把 `identityAt` 从 `project.ts` 导出复用，不要重写一份）。

序列化 `blocks` 时累加字节数，超过 `512 * 1024` 即停止并设 `truncated: true` / `nextCursor` 为下一个 block 的序号。`cursor` 传入时从该序号开始。`rev` 取 `project.ts` 里该 item 当前的 rev（导出一个 `itemRev(entryId, itemId)` 查询函数）。

`index.ts` 导出 `itemDetail`。

- [ ] **Step 4: 放行 Swift 侧**

`DataRuntime.swift:157` 的 guard 现在要求「非 sendTurn 的方法必须带 `workspaceId`」。`itemDetail` 带的是 `sessionId`，改成：

```swift
(method == "sendTurn" || method == "itemDetail"
   ? args["sessionId"] as? String == sessionId
   : args["workspaceId"] as? String == workspace)
```

`LodyKitModule.swift` 加 `AsyncFunction("sessionItemDetail")`，转发到 `runtime.command("itemDetail", payload:promise:)`。照抄 `sendSessionTurn` 那条的写法。

- [ ] **Step 5: TS facade**

`LodyKit.ts` 的 `LodyKitNativeModule` 声明加 `sessionItemDetail(payload: string): Promise<string>;`，导出 `export const sessionItemDetail = (payload: string) => native.sessionItemDetail(payload);`。`modules/lody-kit/src/index.ts` 导出它。

- [ ] **Step 6: 验证**

```bash
pnpm --filter @lody-ios/mobile native:assets
pnpm check && pnpm test
pnpm --filter @lody-ios/mobile ios
```

模拟器构建必须通过（含正常签名）。

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/modules/lody-kit apps/mobile/tests
git commit -m "feat(chat): sessionItemDetail 按需通道"
```

---

## Task 7: 活动行详情 sheet

点活动行开原生 sheet，展示 diff / 终端输出 / 原始输入输出，打开期间保持新鲜。

**Files:**

- Create: `apps/mobile/src/features/sessions/detail/itemDetailPage.tsx`
- Modify: `apps/mobile/src/features/sessions/SessionScreen.tsx`（接 `onActivityPress`）
- Modify: `apps/mobile/src/app/presented/`（按现有 presented 路由的约定注册页面，照抄 `pickerPage` 的注册方式）

**Interfaces:**

- Consumes: Task 6 的 `sessionItemDetail`，Task 3 的 `Row.members`
- Produces: `export const itemDetailPage = definePage<{ sessionId: string; entryId: string; itemIds: string[]; generation: number }>({ ... })`

- [ ] **Step 1: 写页面骨架**

```tsx
export const itemDetailPage = definePage<ItemDetailParams>({
  id: 'session-item-detail',
  title: '详情',
  Component: ItemDetailScreen,
  parseRouteParams: () => {
    throw new Error('请从会话页打开');
  },
  presentation: {
    style: 'formSheet',
    sheetAllowedDetents: [0.6, 1],
    sheetInitialDetentIndex: 0,
    sheetGrabberVisible: true,
    headerVariant: 'transparent',
  },
});
```

**必须是 `formSheet`。** `PresentedPage.tsx:118` 的 `formSheet` 判断只对 `formSheet` 成立，`pageSheet` 下三个 sheet 字段全传 `undefined`。

- [ ] **Step 2: 取数与保鲜**

`useEffect` 里对 `itemIds` 逐个调 `sessionItemDetail`，结果按 itemId 存 state。

保鲜：订阅 `addDataRuntimeListener`，收到该 session 的信封时，在 `entries` 里找到对应 item，比对 `rev`——变了就重取那一个。**不轮询。**

`generation` 处理：params 里带着打开时的 `generation`。监听到 `event.generation !== params.generation` 时，清空已取到的详情与 cursor，显示**加载态而不是错误态**，并等 `event.state === 'live'` 后重新取。在途响应用 `(generation, itemId)` 判定丢弃。

- [ ] **Step 3: 渲染**

- `diff` block：`path` 做小标题，正文用等宽 13/20，增行 `colors.success` 背景淡色、减行 `colors.danger`，逐行前缀 `+` / `−`。横向内容用 `ScrollView horizontal` 包住，不换行。
- `terminal_command`：`$ ${command} ${args.join(' ')}` 单行等宽，下方灰字 `cwd`。
- `terminal_output`：等宽块，`exitStatus.exitCode` 非 0 时顶部一行 `colors.danger` 的「退出码 N」。
- `rawInput` / `rawOutput`：`JSON.stringify(value, null, 2)` 折叠在一个默认收起的段落里。
- `truncated` 为真时底部一行灰字「内容已截断」加「继续加载」按钮，点了带 `nextCursor` 再取一页。
- 取数失败：错误文案 + 重试按钮，**不关闭 sheet**。

- [ ] **Step 4: 接上点击**

`SessionScreen` 传 `onActivityPress={(entryId, row) => void present(itemDetailPage, { sessionId: session.id, entryId, itemIds: row.members, generation: generation.current })}`。

`hasDetail: false` 的组（`aggregate` 里 `members` 全部 `hasDetail === false`）不给点击态——`ActivityRow` 收一个 `disabled` prop。

- [ ] **Step 5: 验证**

```bash
pnpm check && pnpm test && pnpm bundle
pnpm --filter @lody-ios/mobile ios
```

模拟器上用真实会话确认：点活动行开 sheet、terminal 输出完整可读、sheet 打开期间该 item 仍在追加时内容会刷新。

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src
git commit -m "feat(chat): 活动行详情 sheet"
```

---

## Task 8: 权限 sheet

agent 请求权限时自动弹 sheet，作答写回 LoroDoc。

**Files:**

- Create: `apps/mobile/src/features/sessions/detail/permissionPage.tsx`
- Modify: `apps/mobile/modules/lody-kit/data-runtime/session.ts`（新增 `respondPermission`）
- Modify: `apps/mobile/modules/lody-kit/ios/Cloud/DataRuntime.swift`、`LodyKitModule.swift`、`src/runtime/LodyKit.ts`、`src/index.ts`
- Modify: `apps/mobile/src/features/sessions/SessionScreen.tsx`（自动呈现）
- Test: `apps/mobile/tests/session-envelope.test.mjs`

**Interfaces:**

- Produces:
  - `respondSessionPermission(payload: string): Promise<string>`，payload `{ sessionId, entryId, itemId, requestId, optionId }`，返回 `{ state: 'accepted' | 'stale' | 'conflict' }`；`optionId` 不在 `options[]` 里时抛 `invalid_option`，上传失败时抛 `upload_failed`
  - `docSnapshot(): unknown`（`session.ts` 导出，仅供测试断言 doc 实际内容）
  - `acceptEnvelope(state, event, data): 'accept' | 'reset' | 'drop'`（`apps/mobile/src/features/sessions/acceptEnvelope.ts`）
  - `export const permissionPage = definePage<PermissionParams, void>({ ... })`

- [ ] **Step 1: 写失败的测试**

Create `apps/mobile/tests/session-envelope.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptEnvelope } from '../src/features/sessions/acceptEnvelope.ts';

test('信封校验：版本、generation、revision 三道闸', () => {
  const at = (generation, revision) => ({ generation, revision });

  assert.equal(
    acceptEnvelope(at(3, 10), { generation: 3 }, { v: 2, revision: 11 }),
    'drop',
  );
  assert.equal(
    acceptEnvelope(at(3, 10), { generation: 2 }, { v: 1, revision: 11 }),
    'drop',
  );
  assert.equal(
    acceptEnvelope(at(3, 10), { generation: 3 }, { v: 1, revision: 10 }),
    'drop',
  );
  assert.equal(
    acceptEnvelope(at(3, 10), { generation: 3 }, { v: 1, revision: 9 }),
    'drop',
  );
  assert.equal(
    acceptEnvelope(at(3, 10), { generation: 3 }, { v: 1, revision: 11 }),
    'accept',
  );
  assert.equal(
    acceptEnvelope(at(3, 10), { generation: 4 }, { v: 1, revision: 1 }),
    'reset',
  );
  assert.equal(
    acceptEnvelope(at(-1, -1), { generation: 0 }, { v: 1, revision: 1 }),
    'reset',
  );
});
```

`'reset'` 表示 generation 前进：调用方先把本地 `generation` 更新、`revision` 归 `-1`，再接受这份载荷。

同文件覆盖权限作答的四条规则（`loadRuntime()` 用与 `session-runtime.test.mjs` 相同的 esbuild 加载方式，把它抽成 `apps/mobile/tests/helpers.mjs` 供两个测试文件共用）：

```js
test('权限作答：过期 / 非法 option / 已有 outcome / 重复同答', async () => {
  const { runtime, server, pushUpdate } = await openTestSession();
  const entry = server.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e1');
  entry.set('role', 'assistant');
  const items = entry.setContainer('items', new LoroList());
  const call = items.pushContainer(new LoroMap());
  call.set('type', 'tool_call');
  call.set('toolCallId', 'tc_1');
  call.set('kind', 'execute');
  call.set('status', 'pending');
  call.set('permissionRequest', {
    requestId: 'r1',
    options: [
      { optionId: 'once', name: '本次允许', kind: 'allow_once' },
      { optionId: 'no', name: '拒绝', kind: 'reject_once' },
    ],
  });
  server.commit();
  await pushUpdate();

  const args = { sessionId: 's1', entryId: 'e1', itemId: 'tc_1' };
  const outcomeOf = () =>
    runtime.docSnapshot().history[0].items[0].permissionRequest.outcome;

  const stale = await runtime.respondPermission({
    ...args,
    requestId: 'gone',
    optionId: 'once',
  });
  assert.equal(stale.state, 'stale');
  assert.equal(outcomeOf(), undefined);

  await assert.rejects(
    runtime.respondPermission({ ...args, requestId: 'r1', optionId: 'bogus' }),
    /invalid_option/,
  );
  assert.equal(outcomeOf(), undefined);

  const first = await runtime.respondPermission({
    ...args,
    requestId: 'r1',
    optionId: 'once',
  });
  assert.equal(first.state, 'accepted');
  assert.equal(outcomeOf().optionId, 'once');

  const again = await runtime.respondPermission({
    ...args,
    requestId: 'r1',
    optionId: 'once',
  });
  assert.equal(again.state, 'accepted');
  assert.equal(outcomeOf().optionId, 'once');

  const conflict = await runtime.respondPermission({
    ...args,
    requestId: 'r1',
    optionId: 'no',
  });
  assert.equal(conflict.state, 'conflict');
  assert.equal(outcomeOf().optionId, 'once');
});
```

`runtime.docSnapshot()` 是为测试新增的一个导出（`() => active?.doc.toJSON()`），Step 3 一并实现；`openTestSession()` 是从 `session-runtime.test.mjs` 抽到 `helpers.mjs` 的建场函数。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test`
Expected: FAIL

- [ ] **Step 3: 实现 `respondPermission`**

`session.ts`：找到 entry 与 item，按上面四条规则校验后 `item.permissionRequest.outcome = { outcome: 'selected', optionId }`（形状照 `/Users/innei/git/fork/Lody` 的 `PermissionOutcome`），`doc.commit()`，然后**等这次更新推上去**——复用 `sendTurn` 里 `client.append(...)` 的 ok 判定路径。append 失败则抛 `upload_failed`。

Swift 与 facade 的接线照抄 Task 6 Step 4/5（方法名 `respondPermission`，guard 走 `sessionId` 分支）。

- [ ] **Step 4: 实现 `acceptEnvelope` 并接进 `SessionScreen`**

把 Task 1 Step 6 里写在 `useEffect` 内联的那段判定抽成 `acceptEnvelope`，`SessionScreen` 调用它。

- [ ] **Step 5: 写权限 sheet**

`permissionPage`，`style: 'formSheet'`、`sheetAllowedDetents: 'fitToContents'`、`sheetGrabberVisible: true`、`dismissible: true`。

内容：标题（按 `kind` 给「允许执行命令？」/「允许编辑文件？」/「允许调用工具？」）、副标题给 `title`、命令或路径用等宽块、按钮**逐个来自 `options[]`**（`option.name` 作标签，第一个 `kind === 'allow_always'` 或 `allow_once' 的用 `accent` 填充，`reject_*`的用`danger` 文字按钮）。

`options` 从 Task 6 的 `sessionItemDetail` 取（`DetailResponse.options`）。

按钮点击后进「提交中」态（按钮禁用 + spinner），`respondSessionPermission` 成功才 `finish()`；失败保持打开、恢复按钮、显示原因。

- [ ] **Step 6: 自动呈现**

`SessionScreen` 里：

```tsx
const answered = useRef(new Set<string>());
useEffect(() => {
  if (!snapshot.awaitingUserSince) return;
  for (const entry of snapshot.entries)
    for (const item of entry.items) {
      const requestId =
        item.type === 'tool_call' && item.permission?.pending
          ? item.permission.requestId
          : undefined;
      if (!requestId || answered.current.has(requestId)) continue;
      answered.current.add(requestId);
      void present(permissionPage, {
        sessionId: session.id,
        entryId: entry.id,
        itemId: item.itemId,
        requestId,
        generation: generation.current,
      });
      return;
    }
}, [snapshot]);
```

`answered` 只在本次呈现内去重——滑掉不写 outcome，也不再自动弹；转录里该活动行由 Task 3 的 `pendingPermission` 显示「等待你的批准」，点它重新 `present`（此时不看 `answered`）。

- [ ] **Step 7: 验证**

```bash
pnpm --filter @lody-ios/mobile native:assets
pnpm check && pnpm test && pnpm bundle
pnpm --filter @lody-ios/mobile ios
```

模拟器上用真实会话跑一个会触发权限的 turn，确认：sheet 自动弹出、作答后机器继续执行、滑掉不写 outcome 且转录留下可点入口。

- [ ] **Step 8: Commit**

```bash
git add -A apps/mobile
git commit -m "feat(chat): 手机端回答权限请求"
```

---

## Task 9: 长按复制

助手正文长按弹 `UIContextMenu`，复制整条。

**Files:**

- Create: `apps/mobile/modules/lody-kit/ios/Menu/LodyContextMenu.swift`
- Create: `apps/mobile/modules/lody-kit/src/menu/NativeContextMenu.tsx`
- Modify: `apps/mobile/modules/lody-kit/ios/LodyKitModule.swift`、`src/index.ts`
- Modify: `apps/mobile/src/features/sessions/transcript/AssistantProse.tsx`、`UserBubble.tsx`

**Interfaces:**

- Produces:

```tsx
export type NativeContextMenuProps = {
  actions: {
    id: string;
    title: string;
    symbol?: string;
    destructive?: boolean;
  }[];
  onAction: (event: { nativeEvent: { id: string } }) => void;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};
```

- [ ] **Step 1: Swift 视图**

`LodyContextMenu.swift`：一个 `ExpoView` 子类，挂 `UIContextMenuInteraction`，`actions` prop 变化时重建 `UIMenu`。symbol 名走 `LodyTint`/`UIImage(systemName:)`，与 `LodySymbolButton` 同一套解析。所有 UIKit 操作在主队列。选中时通过 `onAction` 事件回传 `id`。

`LodyKitModule.swift` 里 `View(LodyContextMenu.self) { Prop("actions") ...; Events("onAction") }`，照抄 `LodySymbolButton` 的注册块。

- [ ] **Step 2: TS 包装**

`NativeContextMenu.tsx`：`requireNativeView` 包一层，导出上面的 props 类型。`modules/lody-kit/src/index.ts` 导出。

- [ ] **Step 3: 接进转录**

`AssistantProse` 与 `UserBubble` 各包一层 `NativeContextMenu`，`actions` 为 `[{ id: 'copy', title: '拷贝', symbol: 'doc.on.doc' }]`，`onAction` 里 `Clipboard.setString(text)`（RN 内置 `@react-native-clipboard` 若未装，用 `expo-clipboard`——先确认哪个已在依赖里，都没有则用 `Share` 兜底并在此处停下问）。

- [ ] **Step 4: 验证**

```bash
pnpm check && pnpm test && pnpm bundle
pnpm --filter @lody-ios/mobile ios
```

模拟器上长按助手正文，确认菜单出现且复制生效。

- [ ] **Step 5: Commit**

```bash
git add -A apps/mobile
git commit -m "feat(chat): 长按复制"
```

---

## 最终验收

九个 task 全部完成后，在正常签名的 iOS 模拟器上用真实账号数据逐条确认（对应 spec 的验证一节）：

- [ ] 含读文件、编辑、执行命令的真实转录，活动行按连续同类聚合，措辞与 `+N −M` 正确
- [ ] 流式回复期间正文平滑追加，贴底自动跟随，手动上滑后不被拽回
- [ ] 键盘弹出与 interactive dismiss 期间 composer 无跳变
- [ ] 点活动行开 sheet，terminal 输出完整可读；sheet 打开期间该 item 仍在追加时内容会刷新
- [ ] agent 请求权限时 sheet 自动弹出；作答后机器继续执行
- [ ] 滑掉权限 sheet 不写 outcome，转录留下可点的「等待你的批准」，点回去能作答
- [ ] 杀掉 data-runtime 再恢复：不重复发送、不重复作答，UI 以 doc 为准；sheet 若开着显示加载态而非错误态
- [ ] 两台设备同时作答同一权限请求：机器只执行一次；记录手机端显示的 outcome 是否与实际采纳一致
- [ ] 用真实长会话（含大量 terminal 输出）实测载荷体积，确认与工具输出总量脱钩的判断成立

最后一条若不成立，spec 里写明的升级路径是增量投影（data-runtime 只发变化的 entry，RN 按 id 合并），另开一轮。
