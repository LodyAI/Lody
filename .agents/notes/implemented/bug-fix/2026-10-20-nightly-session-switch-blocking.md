# Nightly session switching blocks the renderer

Status: implemented
Translation: current

[中文](2026-10-20-nightly-session-switch-blocking.zh.md)

## Abstract

A native Nightly trace records twelve session-switch clicks taking 96–271 ms to present, with a 191 ms median. React's synchronous render/commit path, forced scroll layout and semantic visibility checks dominate, amplified by duplicate controllers and eager subscriptions. The repair shares the toolbar's controller, localizes edit subscriptions, stabilizes surface refs/events, preserves fixed CSS and narrows cue refresh, lazily mounts child bodies and bounds reuse of static Markdown parsing. Browser probes and isolated application acceptance distinguish verified redundant work from unproven savings; native history readiness and extreme first-render workloads remain separate limits.

## Scope and provenance

This extends the [hosted session-switch investigation](../../proposed/architecture/2026-10-17-session-switch-rendering-cost.md) with a separate native recording. It does not revise that investigation's owner-read correction or its four-second readiness observation. The [scroll engine decision](../../implemented/architecture/2026-09-27-conversation-scroll-engine.md) remains the behavioral contract.

The supplied `Trace-20261020T161455.json.gz` starts at 2026-10-20 08:14:55.200 UTC and contains 164,257 events over about eight seconds. Its compressed SHA-256 is `a5493d631325215f3b3be96597fb30c813fd6db6c365839cbc75dff80d2efc1f`. The renderer is PID 2198, main thread 31877262. The installed bundle matching the trace URL is `main-C6-XEjWR.js`, SHA-256 `ab0c182fbf998cd5b62c76e1ccf0a4816e0449c12643e745483ef91a4505a45d`.

Package metadata reports `0.105.0-nightly.0`, build 114, and a 2026-10-10 build timestamp. Treat these as package metadata rather than proof of correspondence with the current checkout. The actual bundle confirms the measured `clientHeight` getter, scroll transaction paths and semantic router's unconditional layout-effect refresh. The checkout's router has newer interaction behavior, so its exact live cost is unmeasured.

Only aggregate evidence belongs in this note. The attachment stays ignored; extracted bundles, raw trace data and analysis artifacts stay outside Git. No conversations or screenshots become fixtures.

## Measured costs

| Boundary | Observation | Interpretation |
| --- | --- | --- |
| Twelve click interactions | EventTiming duration 96.0–271.1 ms; median 190.9 ms | Input to next presentation, not complete history or typing readiness. |
| Click dispatch | 53.6–223.0 ms; median 144.4 ms; total 1,661.7 ms | Almost the entire dispatch contains a synchronous microtask flush. |
| Renderer scheduler tasks over 50 ms, excluding profiler startup | 17 tasks; 2,020.1 ms total; 1,170.1 ms over their first 50 ms | A trace-derived blocking measure; separate from Devbar's BLK definition. |
| React work | Approximately 3,373 ms inclusive CPU samples under `performWorkOnRoot`; 1,888 ms under synchronous rendering; 1,527 ms under commits | Nested measurements overlap; never add this table's rows. |
| Scroll `afterCommit` | Approximately 504 ms inclusive samples; viewport getter about 464 ms | Much of the getter time is browser style/layout work forced by the read. |
| Style/layout initiated by `readViewportHeight` | 248 events; 470.5 ms inclusive event sum, about 464.9 ms after removing nested overlap | The most expensive individual layout is 38.7 ms. |
| Semantic router `paint` | Approximately 174 ms inclusive samples; visibility checks initiate 95.8 ms of style/layout | Layout-effect refresh, DOM scans and visibility reads contribute before paint. |
| React HTML replacement | Approximately 280 ms self samples in the `innerHTML` setter; 898 update-path `ParseHTML` events totaling 178.9 ms | Existing elements are reparsed repeatedly. The trace does not identify their React component or establish unchanged markup. |
| Other sampled paths | Markdown `parse` about 126 ms; garbage collector about 155 ms; `loadReplica` about 101 ms | These do not dominate this recording. `loadReplica` CPU does not measure owner/network wait. |
| Browser paint | 880 `Paint` events totaling 47.3 ms | Browser painting alone is substantially smaller than the synchronous render/commit work. |

**Attribution refinement:** the twelve click-dispatch intervals contain 202 update-path HTML reparses totaling 42.4 ms and approximately 69.5 ms of `innerHTML` self samples. The other 696 update reparses total 136.5 ms outside dispatch; outside-dispatch setter samples total approximately 210.5 ms. These may include switching follow-up work as well as independent updates. Neither the entire 280 ms setter total nor the 898-event count can be assigned to click handlers or called avoidable work.

Devbar [sampling](../../../../apps/electron/src/renderer/src/devbar/index.tsx) defines BLK as the sum of each observed long task's **entire duration** since the preceding successful sample, nominally about one second. It neither measures blocked disk I/O nor subtracts the first 50 ms as standard total blocking time does. A busy task also prevents animation callbacks, directly reducing the displayed FPS. An idle live snapshot returning 60 FPS does not invalidate the switching trace.

The initial 455.8 ms renderer task includes 450.5 ms starting the CPU profiler. Exclude it from session-switch latency and proposed savings. Profiling overhead also affects the remaining recording; no device-wide percentile or uninstrumented baseline is established.

For reproduction, join `Profile` and `ProfileChunk` by process and profile ID: chunks arrive on the profiler thread rather than the original main-thread ID. Advance sample time using `timeDeltas`. Aggregate self samples by call-frame identity; count each function once per sample for inclusive totals to avoid recursive React-stack duplication. Group style/layout by its initiating stack frame, remove nested interval overlap, and compare click dispatch with `EventTiming` rather than summing nested events.

## Responsibilities and likely mechanism

The [React scroller adapter](../../../../packages/components/src/components/ai-gui/conversation-list/engine-conversation-scroller.tsx) calls `afterCommit` in a layout effect on every commit. Its host reads `clientHeight`. In the [controller](../../../../packages/components/src/lib/conversation-scroll/controller.ts), both the initial transaction and `isSettled` can refresh viewport geometry; `isSettled` explicitly forces a refresh. This makes an apparently unchanged-list fast path a potential synchronous layout boundary after another component dirties the document.

The [semantic router hook](../../../../packages/components/src/lib/commands/use-semantic-action-router.ts) also refreshes after every commit. The [router](../../../../packages/components/src/lib/commands/semantic-action-router.ts) scans blocking layers and action scopes, checks visibility, and updates active-scope attributes. A body-wide MutationObserver adds another refresh source. The deployed bundle confirms that visibility checks cause full style recalculations of roughly 2,890 elements in individual 15 ms events.

The trace therefore supports a sequence of React DOM updates, synchronous scroll measurements, additional updates and semantic visibility reads within the same input task. Removing a reader does not necessarily remove that layout: another reader or the browser frame may still need it. Semantic routing is a developer beta gated by `semanticShortcutsEnabled`, not a cost every configuration necessarily pays.

## React source and the critical path

The installed bundle identifies both React and React DOM as production 19.2.0. Its implementation agrees with the version-matched upstream [root scheduler](https://github.com/facebook/react/blob/v19.2.0/packages/react-reconciler/src/ReactFiberRootScheduler.js), [work loop](https://github.com/facebook/react/blob/v19.2.0/packages/react-reconciler/src/ReactFiberWorkLoop.js), [memo reconciliation](https://github.com/facebook/react/blob/v19.2.0/packages/react-reconciler/src/ReactFiberBeginWork.js) and [DOM prop updates](https://github.com/facebook/react/blob/v19.2.0/packages/react-dom-bindings/src/client/ReactDOMComponent.js).

```text
click -> root-schedule microtask -> synchronous render
      -> DOM mutations -> layout effects
      -> synchronous-lane passive effects -> any new synchronous work -> presentation
```

`processRootScheduleInMicrotask` flushes pending synchronous work, and `performWorkOnRoot` chooses the synchronous renderer for blocking work. `flushSpawnedWork` can flush passive effects for synchronous lanes and drain new synchronous updates before returning. Consequently, moving work from a layout effect to `useEffect` alone does not establish that the next frame is unblocked. The trace samples about 2,405.5 ms through the scheduler-microtask entry and only 42.3 ms through the explicit React DOM sync-flush entry; the internal function name `flushSyncWorkAcrossRoots_impl` does not establish widespread application calls to `flushSync`. Explicit calls sampled here belong to selection pointer handling (about 34.5 ms) and scroll ResizeObserver correction (about 7.8 ms).

| Sampled phase | Whole recording | Inside twelve click dispatches |
| --- | ---: | ---: |
| Synchronous render | 1,887.9 ms | 750.9 ms |
| DOM mutation effects | 476.0 ms | 146.5 ms |
| Layout effects | 707.5 ms | 351.0 ms |
| Passive effects | 314.7 ms | 227.9 ms |

These are sampled inclusive paths, not additive exclusive phase timings. Within the layout-effect samples, mutually exclusive attribution gives 504.1 ms to the scroller, 149.0 ms to semantic cue painting, and 54.5 ms elsewhere. The scroller and semantic router therefore account for about 92% of that sampled phase. Passive effects include approximately 49.6 ms publishing viewing presence, 40.8 ms in Machine Flock consumer cleanup and 41.8 ms in organization-retry setup/cleanup; none is evidence of network waiting inside those samples.

## State and subscription ownership

This path uses React local state and TanStack Router for view/route identity, Jotai atoms/selectors for application UI and runtime handles, Loro CRDT plus Mirror for session control state, Flock for metadata/file indexes, and a windowed ConversationView for history. `useSessionDoc` adapts external subscriptions through frame-coalesced React state; the runtime retains warm documents separately from transport subscriptions. These are multiple subscription owners, not a single Zustand/Redux store.

React's [memo guidance](https://react.dev/reference/react/memo) favors local ownership and stable inputs over indiscriminate caching; its [Effect guidance](https://react.dev/learn/you-might-not-need-an-effect) discourages chains that mirror derived state. The repair moves work to the mounted consumer and removes redundant commit work. It preserves synchronous URL, composer and command identity rather than deferring the session or adding an Effect-driven state mirror.

## Business components that amplify updates

The largest named business render entry is `SessionChatInterface`: approximately 199 ms inclusive samples, compared with 68 ms for `SessionDetail`, 54 ms for `SessionChatInputArea`, 47 ms for `ChatComposer`, and 123 ms for Markdown. These are function/hook entry samples, not complete React subtree durations or render counts. Base UI's generic `FastComponent` accounts for another 122 ms, so closed controls and their hooks also contribute. Hook dependency comparison takes about 96 ms self time and context propagation about 74 ms; most of each occurs outside click dispatch. Those totals alone do not identify the update initiator.

The following patterns existed in the deployed bundle and baseline checkout `a27a34c9e`:

| Boundary | Confirmed source behavior | Consequence and limit |
| --- | --- | --- |
| [Conversation props](../../../../packages/components/src/components/sessions/session-detail.tsx), `getSharedChatSurfaceProps` | Each parent render creates a new callback ref plus several action closures. | React memo requires both equal props and the same ref. A new ref alone prevents bailout; it also changes `useImperativeHandle`'s effective dependencies. Stabilizing only that ref is insufficient while other props still change, and cannot skip a real session-identity change. |
| Desktop header in the same file | `desktopHeaderToolbar` mounts `SessionChatInterface` with `hideMessageArea` and `headerVariant="toolbar"`, alongside the conversation's own instance. | [Chat interface hooks](../../../../packages/components/src/components/sessions/session-chat-interface.tsx) execute before the JSX hides the message area. A header-only instance still runs many chat-controller hooks. The trace does not isolate its share of the aggregate 199 ms. |
| Edit mention source in the chat interface | `enableCodeCollabProvider: true` is supplied before any editor is opened, including the header-only instance. | Sampled `useSessionMentionSource` work under this component is about 40 ms. Readiness when opening an editor must be preserved if acquisition moves to that boundary. |
| [Mention expansion](../../../../packages/components/src/components/mentions/mention-expansion.ts) | Stream edit, input area and composer consumers independently call the expansion hook, including session, Role and Skill catalogs. | The path costs about 83 ms inclusive samples. [Shared item memoization](../../../../packages/components/src/components/mentions/mention-session-source.ts) already avoids some repeated slug construction; it does not remove each consumer's hooks and subscriptions. |
| [Legacy ScrollArea wrapper](https://github.com/LodyAI/Lody/blob/683aaec1fe8cb9f1f1eb18ee447b8cd8341a1697/packages/components/src/ui/scroll-area.tsx) | Radix 1.2.10's viewport returns a fresh `dangerouslySetInnerHTML` object containing fixed CSS on every render. | React sees a changed prop and writes `<style>.innerHTML` again. This is a confirmed redundant producer and a candidate for some recorded reparses, not an identification of all 898 events. |

React DOM compares the `dangerouslySetInnerHTML` wrapper by identity before calling `setProp`; that setter assigns the contained HTML without a second string equality check. The deployed registry `InlineSvg` already interns its wrapper and the browser control below confirms the value of that implementation. Reapplying that existing SVG fix is unsupported. Other candidates, including Mermaid markup and legacy ScrollArea CSS, require host-element attribution before assigning measured savings. The CPU stack has no Fiber/component identity at `commitHostUpdate`, so it cannot reconstruct that missing ownership.

## Synthetic browser verification

An isolated local page runs production React/React DOM 19.2.0 and actual Radix ScrollArea 1.2.10 in headless Chromium 154. It uses only synthetic markup, a native `innerHTML` setter wrapper and actual React DOM roots. After mounting, twenty updates produce:

| Case | Setter writes | Writes with the same previously assigned string |
| --- | ---: | ---: |
| Fresh SVG wrapper per render | 20 | 20 |
| Stable SVG wrapper | 0 | 0 |
| Actual Radix viewport | 20, all to `style` | 20 |
| Stable CSS wrapper control | 0 | 0 |

A separate memoized `forwardRef` surface has unchanged ordinary props over 21 parent renders. Fresh callback refs cause 21 surface renders; a stable ref causes one. This establishes that ref identity alone can defeat memo, not that every application render would disappear after stabilizing it.

A real browser click triggers state, a layout-effect state correction and passive effects. Its observed order is `click -> layout(false) -> passive(false) -> layout(true) -> passive(true) -> animation frame`. This confirms the before-frame cascade in production, without adding delays or using wall-clock assertions.

Probe source, bundle, dependency lock and aggregate results remain outside Git under `/tmp/lody-react-hotspot-probe/` and `/tmp/lody-react-hotspot-{results,phase}.json`. The probe source SHA-256 is `ea5c77dd75b1f3f3f27e98009a4452a9134e3045de82afbb33af2d374772cd4a`. These experiments establish observable update behavior; they do not measure Nightly latency, real transcripts, its exact Chromium build or recoverable milliseconds.

## Adopted repair and verification

The desktop tab row receives a portal from its existing root conversation controller. It no longer mounts a second controller just to render buttons. Root-session metadata and selected-tab action targets remain distinct. A surface adapter holds its imperative ref and browser/simulator/fork event callbacks stable while forwarding the latest committed handlers. This does not promise a memo bailout when other data or toolbar props change.

A focused Tab-switch pass identifies another changed prop: the annotation-submission callback factory creates a function on every parent render. Surface event adapters now also stabilize annotation, comment, PR/changes and session-navigation handlers; they forward the latest committed action, including optional-handler availability. The toolbar and sidebar-toggle JSX are memoized by their actual inputs so unrelated parent updates do not invalidate the root controller.

Desktop child conversation bodies now mount on first URL selection and remain mounted within that root session. The existing root controller still supplies the toolbar. A fork target awaiting history retains its explicit preparation exception. Visited identities reset in the existing render-phase session reset, closed identities are pruned, and the existing store acquire/release path handles actual mounts and unmounts. This changes no transport ownership, persistence policy, readiness gate or error delivery and adds no resource cache. The visited set records mounted history, not a second selection authority.

Desktop conversation shells have definite absolute-inset bounds and strict CSS containment. This removes content from the shell's intrinsic-size calculations without deleting valid scroll measurements. Inactive surfaces retain `display: none`; the existing hidden-engine pause, resize/reshow path and reading-anchor protocol are unchanged. Changing hidden rendering to visibility/content-visibility is unnecessary for this repair.

A subsequent 30-switch profile isolates approximately 570 ms of inclusive `react-markdown` parser samples, compared with about 99 ms of layout and 66 ms of paint. These sampled diagnostic values are not acceptance latency. Reopening unchanged finished prose repeated the complete Markdown parse. Static renderers now use a window-owned raw-AST LRU per fixed grammar configuration, with limits of 64 entries, 1,048,576 source characters and 8,192 nodes; inputs over 131,072 characters bypass retention. Trees are cloned before downstream transforms, and neither React elements, callbacks, VFiles nor transformed HTML are retained. Streaming prefixes bypass this cache. Sanitization, URL policy, custom components, math, citations and search still run for the current consumer.

The cache has no I/O lifecycle, failure map, readiness gate or session resource lease. A failed parse is not retained; eviction only causes recomputation. Its setup assertion requires the parser already installed by react-markdown's `remark-parse` stage, which runs before the cache plugin in both fixed configurations. Behavioral tests cover fresh ASTs after mutating consumers, independent grammars, entry/source/node eviction, oversized bypass, recovery after parser failure and HTML policy across remounts.


Edit-and-resend acquires its file source and catalog expansion only while the editor is mounted. The stream no longer subscribes for a closed editor. The editor expands the original input, trims it, and reanchors spans before handing off the submission. The normal composer's input and clipboard consumers remain separate; no new global store or conditional hook was introduced.

The existing Radix 1.2.10 patch interns the fixed viewport CSS wrapper in both module formats, preserving the earlier scroll-poll cleanup. CSSOM tests verify stylesheet/rule identity across real content updates, alongside scroll-end and unmount cleanup. The lock changes only the patch hash.

Semantic cue refresh no longer runs after every React commit or ordinary body-content mutation. It observes scope/layer boundaries and their ancestor visibility, including class/style changes, and shares one visibility snapshot per paint. Dispatch still reads current visibility and blocking layers, even before observer delivery. Existing pointer, keyboard, modal, reset, deferred activation and teardown contracts remain covered.

The scroll engine's geometry measurements, anchors, resize/coverage checks and single scroll writer are unchanged. Removing valid reads would hide symptoms while risking a wrong viewport. No Effect lifecycle migration is needed for these React ownership and fixed-CSS changes; the existing resource cache owns acquisition/release.

Application verification uses separately built, pinned OSS Electron checkouts, actual main/preload/renderer and bundled CLI, isolated temporary user data, and the repository's deterministic external ACP fixture through the real UI. No user Nightly process, account or transcript is modified. A closed synthetic seed is copied for each variant. Playwright records the complete windows; CDP runtime snapshots, EventTiming, frame intervals and native HTML setter instrumentation provide aggregate evidence. Video recording/instrumentation affects both variants; these measurements are not a native Nightly latency claim.

## Initial application acceptance

Final acceptance uses one frozen runner (SHA-256 `aa159fc0da9037edd9b3ef4408306bcd21acfed86b1412aafe76a6afa85db592`), the same closed seed of twelve 8/32/64 KiB sessions, and 240 sidebar clicks per variant. Both variants pass draft isolation, toolbar width toggling, search and rename/cancel. The baseline is `a27a34c9e`; the final source digests are `c04ddc91390084172a25fd3bf77b8421dc3768840a648ff28c233fa7196dcd7e` (before) and `cde9f468c6d5ebc265d8f417728b1e709e3f20cf68c27d007bdd9e5184319363` (after).

| Final paired measurement | Before | After |
| --- | ---: | ---: |
| Unchanged `<style>.innerHTML` writes | 1,685 | 0 |
| Renderer task CPU over the measured loop | 17.512 s | 15.702 s |
| Click presentation p50 / p95 | 72 / 88 ms | 64 / 80 ms |
| Click processing p50 / p95 | 35.75 / 48.8 ms | 31.3 / 43.8 ms |
| Long tasks: count / total duration | 12 / 640 ms | 5 / 294 ms |
| TBT: duration above each task's first 50 ms | 40 ms | 44 ms |
| Animation-frame gap p95 / maximum | 32.5 / 34.3 ms | 17.7 / 50 ms |

Task CPU falls about 10.3% and long-task duration about 54.1% in this pair. TBT and the worst frame do not improve; this is reduced repeated work, not a guarantee that every tail sample gets faster. An earlier comparison recorded 1,858→0 unchanged CSS writes and 2,395→362 ms of long tasks, but a 72 ms presentation median in both variants. These differences illustrate run/threshold sensitivity; no timing result is a unit-test gate. The harness hides its owned windows and disables background throttling: rAF intervals are rendering observations, not a physical display FPS measurement. No CPU sampler ran in these comparison loops.

A separate after soak passes 1,000 Playwright sidebar switches, 300 frame-driven DOM-click navigations, per-session draft restoration and the final route/composer target. Post-GC DOM nodes change 3,009→2,973, documents remain two, listeners change 936→937, and JS heap grows 85,340,496→104,551,804 bytes. This bounded run does not prove an absence of heap retention. A separate beta workflow passes 24 switches, native application-menu close of a draft tab while preserving its root, and twelve real send/reply rounds. The custom ACP provider correctly exposes no builtin-only edit action; editing is covered by real-editor component tests for mention expansion, trim/span reanchoring and IME suppression, not a builtin-provider edit video. Both before/after restore a 256 KiB message, read all 262,220 rendered characters and accept a draft. The earlier whole-page text-matcher timeout is not a diagnosis of an application hang.

Validation: both OSS application builds pass; 103 focused tests pass; the final components suite passes 5,710 tests in 585 files with the known boot-shell file excluded. Root type checks, lint, Effect lint, i18n and all boundary guards pass. Root `pnpm check` stops on the existing Git identity test (4,428 CLI tests pass); the boot-shell storage-unavailable assertion also fails. Both failures reproduce unchanged at the before revision. `pnpm format`, scoped Oxfmt and `git diff --check` pass. Docs check reports only the six existing Kimi/Pi links in the older subagent-events note; no protected topic hash changes.

Raw synthetic evidence stays outside Git under `/tmp/lody-session-switch-acceptance/`; the frozen runner is `/tmp/lody-session-final.mts`. Downloadable comparison/original/workflow videos and the aggregate report live under ignored `.lody/attachments/session-switch-performance/`. The side-by-side export takes 25 seconds from ten seconds into each original at normal speed; it is not frame-synchronized by individual interaction. Timing attribution comes from the JSON measurements, not the clip's wall-clock lengths.

## Focused Tab and session acceptance

A separate frozen round compares the previous repair with the final focused changes, rather than comparing again with `a27a34c9e`. Its runner SHA-256 is `4d4ea75a27ec56741797a72c3429efaff13da905bc36f48262984cf00f6ca94d`. Each variant receives a fresh copy of the same twelve-session seed with four durable child tabs; rendered replies are checked at 8/32/64 KiB. Each variant performs 160 sidebar session switches and 160 conversation Tab switches. No CPU sampler or Playwright snapshot tracing runs in these measured loops; video recording and passive observers run in both variants. The JSON artifact owns the three-file source manifests and raw observations.

| Paired observation | Previous repair | Final |
| --- | ---: | ---: |
| Session click processing p95 | 79.5 ms | 30.2 ms |
| Tab click processing p95 | 30.4 ms | 14.1 ms |
| Session click presentation p50 / p95 | 72 / 120 ms | 56 / 72 ms |
| Tab click presentation p50 / p95 | 72 / 72 ms | 56 / 56 ms |
| Session-loop maximum frame gap | 68.6 ms | 18.7 ms |
| Session-loop frames over 25 ms | 42 / 864 | 0 / 650 |
| Long tasks over both loops: count / duration | 28 / 2,163 ms | 0 / 0 ms |
| Standard TBT over both loops | 763 ms | 0 ms |
| Renderer task CPU over both loops | 18.005 s | 10.499 s |

Frame-gap p95 remains approximately 18.5 ms in both variants, so the evidence supports reduced processing, tail gaps and long tasks, not improvement of every percentile. A separate sampled 30-switch diagnostic reduces inclusive parser samples from 570.3 to 4.1 ms while layout stays about 98 ms and paint about 64 ms. This confirms reuse of pure parse work rather than removal of necessary geometry. Timing is diagnostic, never a regression-test threshold or a physical-display FPS claim.

Final soak passes 500 additional Playwright session switches, 500 Tab switches, 150 frame-paced session DOM clicks and 150 frame-paced Tab DOM clicks. Both frame-paced bursts record no long tasks; session frame-gap p95 / maximum is 18.5 / 34.2 ms, and Tab is 18.4 / 18.7 ms. The single session burst frame above 25 ms prevents an all-frames or all-hardware smoothness guarantee. Post-GC, the matching warmed state changes from 5,457 nodes / 1,300 listeners / 98,640,112 heap bytes after paired measurement to 5,458 / 1,302 / 106,651,380 after soak; documents remain two. This bounded observation does not prove absence of retention.

Application checks pass per-tab draft isolation, semantic reading position across hide/show and route teardown, selected-child rename and actual search highlight, width toggling, native menu close, closed-body unmount and route reentry. Reading restoration compares the same row's screen position: preceding rows can remeasure without changing what the reader sees. Cold entry into the five-tab workspace mounts two controllers instead of five; the root still owns the toolbar and only the selected child acquires its body. The pending-fork preparation exception is preserved in source; this synthetic custom-provider round does not exercise builtin-only forking.

Both variants emit the same existing boot-time RuntimeProvider initialization AbortError before measured switching; neither records a page error during the switching run.

The final OSS application build, component typecheck, scoped lint, root format and 5,719 tests in 586 files pass. The known boot-shell environment failure remains excluded; Markdown-specific coverage includes 231 passing tests. Docs check reports only the same six older Kimi/Pi links. Artifacts are ignored under `.lody/attachments/session-switch-smooth/`: the sixteen-second comparison uses normal-speed, phase-aligned excerpts, not synchronized individual interactions; originals, frozen runner and aggregate report are included.

## Remaining limits

The original trace cannot identify the exact host producer of all HTML reparses or quantify owner/network readiness. The prior hosted investigation's four-second wait remains a separate observation. The running Nightly had no CDP listener and was not restarted; isolated app verification does not reproduce its complete dataset or build. Large-message first rendering and richer multi-turn/preview workloads must be reported separately from warm switching.
