# Make the share reader navigable and give the pane a real foot

Status: implemented
Translation: current

[中文](2026-09-14-share-reader-navigation-and-foot.zh.md)

## Abstract

Four defects made the anonymous share reader read as a mock-up of the product
rather than a page for reading a published conversation: the conversation tree's
selected row used `bg-accent`, and `--accent` is not one of this project's theme
tokens, so the utility resolved to no background and nothing was ever marked;
the sidebar toggle mounted and unmounted the tree, which cannot transition, so
it blinked and shoved the transcript sideways; every conversation switch refetched
a history that is immutable by construction, so walking back through the tree
meant waiting again; and the pane's foot was a replica of the product composer,
inert and `aria-hidden`, with the two real actions floated over it, costing
about 150px of a page whose only content is the transcript. The tree now tints
the open pane's root with `foreground`, the sidebar animates its width with rows
mounted and `inert` while closed, completed reads are kept in memory for the life
of one `StaticShare`, and the foot is one short action row. The cache is memory
only and covers history alone — attachments are still re-read on every switch,
and nothing survives a reload.

## Decision

### The tree had no selection at all

`session-share-page.tsx` marked the selected row with `bg-accent` and hovered
with `hover:bg-accent/50`. `--accent` is defined nowhere in this repository —
`packages/configs/tailwind-preset.cjs` maps the utility to
`hsl(var(--accent) / <alpha-value>)`, and `components/tasks/task-body-editor-surface.tsx`
already carries the comment "`--accent` is not an app token". An undefined
custom property makes the declaration invalid at computed-value time, so
`background-color` falls back to `transparent`: the row was styled with a rule
that painted nothing, in both themes, since the tree shipped.

The row now tints the reader's own `foreground` at 10% with a matching border,
which is the shape the app's sidebar uses for a selected session row
(`bg-sidebar-foreground/10` there), and inactive titles recede to
`text-muted-foreground` so the marked one reads as the current position rather
than as one of several equal rows. `aria-current="page"` was already correct and
is unchanged; only the visible half was missing.

What the mark means is worth stating, because the tree and the tab strip name
different things. The tree holds independent conversations; a child Tab is named
by `tab-pill-strip.tsx` in the pane. So the tree marks `panes.root` — the
conversation the open pane belongs to — and selecting a child Tab keeps that
entry lit instead of clearing the tree.

### A conditional element cannot animate

The sidebar was `{hasTree && treeVisible && <nav …>}`. React unmounts the element
on collapse, so there is no box left to transition and the transcript jumps into
the freed space in one frame.

The `nav` is now always mounted while `hasTree`, clips its content
(`overflow-hidden`), and animates between `sm:w-56` and `sm:w-0`. The rows live
in an inner column that keeps its own `w-56`, so they slide out of the clipping
box instead of reflowing to a one-character column on the way, and the right
border travels with them rather than surviving as a 1px line at zero width.
A collapsed tree is `inert`, which keeps Tab and clicks out of an off-screen
list that is still in the DOM, and `motion-reduce:transition-none` drops the
animation for a visitor who asked for that.

### Re-reading an immutable history

`useShareConversation` created a reader per `conversationId` and reset to a
loading snapshot on every change. A published deployment is immutable — that is
the whole premise of static sharing, and readers pin one deployment for all
objects — so a conversation that loaded once can never have a different answer
later. Refetching bought nothing but a spinner.

Completed reads are now kept in a `Map` keyed by conversation, scoped to one
`StaticShare` object. The lookup happens during render, so a revisit shows the
transcript in the same commit rather than flashing loading first. Only a `ready`
read is reusable: an `unavailable` one is retried on return, because a failed
read here can also mean a transient network failure and pinning that verdict for
the life of the page would strand the visitor. A new deployment, a reset link or
a changed credential produces a new share object, and the map empties in the same
render that adopts it — the cache cannot outlive the authority it was read under.

This is memory, not the local durable history cache the reader is forbidden to
create: nothing is written to storage, and a reload re-reads everything.

### The composer was scenery

The foot rendered `chat/composer-surface.ts`'s exact resting surface at
`min-h-[112px]`, `aria-hidden` and non-focusable, with a translucent overlay
carrying Copy as Markdown and Copy Agent Prompt. The intent was to show what the
page would be if the conversation were yours. The cost was that a reader gave roughly 152px of vertical
space — on a phone, a visible fraction of the viewport — to a control that
cannot be used, on a page that exists to show a transcript. The new row measures
67.75px in Chromium at 1280px, with no rule separating it from the transcript:
an opaque background is enough, and a border read as a second tab bar.

`session-share-composer.tsx` is now `session-share-actions.tsx`: one row with the
same two buttons and the agent-access disclosure beneath them, inside the same
`ConversationColumn`. The disclosure stays visible because
`specs/session-sharing.md` requires it. Clipboard rejection still exposes the
prompt for manual copying. Nothing about what a visitor can do changed; only the
furniture around it is gone. `sharing.agentComposerPlaceholder` was the
placeholder text of the fake field and is removed from both locales.

## Alternatives considered

Caching attachments alongside history was rejected for now. Images are re-read
on every conversation switch and do flash their "Loading attachment…" placeholder
on a revisit, so the fix is incomplete from a visitor's point of view. But a
deployment is bounded at 256MB and a single object at 100MB, so an unbounded blob
cache could hold a quarter of a gigabyte of decoded images for a share the visitor
browsed through, with object URLs that must then be revoked on a schedule nobody
owns. That needs a stated bound and its own decision; history is small, bounded
by 32 conversations, and is what the report was about.

Keeping the tree mounted but animating `opacity` instead of `width` would avoid
the clipping box, but the transcript would not reclaim the space, which is the
point of collapsing it.

Giving the reader its own `--accent` value was rejected: the app has deliberately
never defined one, and adding it here would make `bg-accent` work on the share
page and silently keep failing everywhere else it is used.

## Evidence and limits

`tests/session-share-page.test.tsx` gains three behavioural cases and keeps its
existing thirteen. The cache test drives the real `SessionSharePage` with a
`readHistory` that records each call and is then made to hang: after visiting a
second conversation and returning, no third read is issued and the Markdown
export is live immediately, copying the first conversation's text. Reverting the
cache makes it fail with `['c1','c3','c1']`, so it detects the regression rather
than restating the implementation. The selection test asserts the tree's
`aria-current` follows the open pane and stays on the root while a child Tab is
selected. The sidebar test asserts the rows stay mounted and the collapsed `nav`
becomes `inert`.

jsdom computes no styles, so no test can see that `bg-accent` painted nothing or
that the sidebar slides. Those were reviewed in Chromium against the new
`Sharing/SessionShareReader` stories, which drive `SessionShareSurface` from
props with no share client: light and dark, 1280px and 390px, with the tree, with
a single conversation, and with the transcript still loading. Measured there: the
marked row resolves to a real `oklab(… / 0.1)` background where an inactive row
stays `rgba(0,0,0,0)`, the `nav` carries `width 0.2s cubic-bezier(0,0,0.2,1)` and
tweens 165→95→51→24→8→0px across a collapse, it is `inert` once closed, and the
action row has `border-top-width: 0px`.

`tsgo --noEmit`, oxlint and `node scripts/check-i18n.mjs` pass, and
`pnpm run docs check` reports no errors. The whole `@lody/components` suite runs
474 of 476 files green; `control-plane-mirror` and `conversation-view-hooks` fail
on the 5s default timeout under full-suite parallel load and pass in isolation.
Neither imports anything this change touches. Full workspace `pnpm check` was
not run.

Limits: attachment reads are not cached, as recorded above. The cache has no
eviction — it is bounded only by the manifest's 32-conversation cap, and a share
of 32 large histories keeps all of them in memory once visited. No hosted
deployment was exercised; the stories and tests use synthetic fixtures.

`packages/components/src/components/sharing/AGENTS.md` now stands at 8185 bytes
against an 8192-byte gate. It was already past the 7000-byte routing warning
before this change, and the next contributor will have to route a topic out
before adding a rule.

Supersedes the foot described in
[the reader layout note](2026-09-09-session-share-dialog-and-reader-layout.md);
that note's dialog decisions are unchanged.
