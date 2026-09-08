# The mention pipeline

Why the mention sources in
[`packages/components/src/components/mentions`](../../packages/components/src/components/mentions/AGENTS.md)
are shaped the way they are. The rules live in that `AGENTS.md`; the file index
lives in its `README.md`.

## One mention, five stages

1. **Trigger and menu.** `@` opens the two-level menu; `$`, `#`, and `/` keep
   their direct behavior. `enableAtMentions` decides what `@` can reach, and it
   gates both trigger registration and whether `<Mention>` mounts at all — a
   source missing from that list silently degrades the composer to a plain
   textarea and drops its type.
2. **Candidates.** Each category builds and caps its own rows. A row is a
   registered collection item that arrow-key movement walks, so an uncapped source
   degrades navigation, not just render time. Ranking the file index is the
   expensive one, which is why `getCandidates` must stay lazy and a bare `@` calls
   none of them.
3. **Commit.** The candidate's `insertText` is what the user sees in the prompt;
   the committed *range* is what carries structured identity (a session id, a Role
   id) that no text form could.
4. **Draft persistence and hydration.** Ranges are stored beside the draft, and
   rebuilding them from text is only a fallback.
5. **Before send.** One hook rewrites the ranges that need rewriting, and the
   resulting spans are frozen into the message.

## Ranking

Issues and PRs share one cache, and the shared ranking caps its result set.
Ranking the merged list first therefore lets a long issue list starve every PR out
of the PR category, so the slices are partitioned once by `useMentionCategories`
rather than re-derived per keystroke.

The vendored VS Code `scoreFuzzy` is used with non-contiguous matching enabled: a
query may skip words, spaces, and punctuation, while consecutive, separator, path,
case, and camel-case matches receive the same bonuses as VS Code.

## Activation is not revalidation

An aggregate query activates every category, so an unconditional refetch would
bill a mention aimed somewhere else. The fetch timestamp rides on the cached entry
(like the file source's `fetchedAt`) so it survives the IndexedDB round trip;
stored beside the entry instead, every reload would look unfetched and refetch on
the first `@`.

## Drafts, hydration, and the reasons behind them

A mention that had to be rebuilt from text needed its source loaded, so it spent
every return looking like plain text — and never came back at all if the source
never loaded. Hence persistence of the narrow `PersistedMentionRange`: the live
range carries callbacks, which `JSON.stringify` writes as `{}`.

`mergeHydratedMentions` rejects an *overlapping* range, not just an exact
duplicate, because a session and a path are now the same shape: two sources can
each claim `@fix-ci` at different ends, and only rejecting overlaps keeps the
restored range authoritative.

`draftKey` exists because a composer that swaps drafts in place cannot otherwise
tell a swap from a very large edit: the outgoing draft's ranges stay committed and
land on the incoming text at their old offsets, while hydration — which arms once
per mount — has already fired, so the incoming draft's mentions never appear.

Hydration latches the first non-empty text rather than the first render's, because
a persisted draft is not there on mount: `atomWithStorage` initialises with its
default and reads storage in `onMount`, so latching at mount latches `''` and the
"only hydrate the text I measured" guard never passes again.

## Sessions

A session mention commits as a plain `@<title-slug>`: the old `session:` marker
was only ever an anchor for the before-send rewrite, and the user had to read it.
It is still the only type whose displayed text differs from what the agent
receives.

Dropping the marker is why hydration has to break a tie:
`hydrateSessionMentionsFromText` skips any token the file source already knows.
Paths are the common case, and mistaking one for a session silently turns a file
reference into a history query, where the reverse only leaves a token unexpanded —
which the user can see. For the same reason a token with no committed range is
sent verbatim: a stale token the agent can ignore beats a confidently wrong
session id.

The slug → id store is synchronous on purpose, since expansion runs on the send
path and an async store would make that whole path async. Its write is skipped
when the serialized map is unchanged, because the session list ticks several times
a second while an agent streams and `setItem` blocks.

`useSessionMentionItems` is a single owner because the composer and
`useMentionPromptExpansion` are both mounted on a session screen, and deriving
items separately re-slugged every visible session twice a tick. It reads the
child-inclusive projection because mentioning is an addressing surface, and
review/task child sessions are exactly what gets referenced.

A drop must produce a real range: a token with no range is sent verbatim, so a
text-only append would look right in the composer and reach the agent as a word.
The overlay lives on the conversation column rather than inside each keep-alive
tab page, where hidden panes and draft tabs would make it vanish or stack on the
wrong surface.

## Agent Roles

A Role mention borrows the session mention's shape with a different payload. The
emoji replaces the category glyph because the category header already says these
are Agent Roles, so a second generic glyph only crowds out the Role's own mark;
the emoji is boxed and clipped because the icon slot covers one character of real
text and an emoji glyph is wider than a latin one. The committed range carries
only the Role id, and only the composer holds the live catalog, which is why the
composer wraps the caller's chip resolver.

The transcript freezes the mark with the span so renaming or re-marking a Role
later cannot repaint history, and painting a bubble never waits on a mutable
catalog. `MessageTextSpanSchema` is `.strict()`, so a span field missing from
`sanitizeMessageTextSpans` fails the whole block list and the send path answers a
real message with "please enter something to discuss" rather than dropping one
chip.

`agent_role` is the one kind the copy button collapses back to its label: the
rewritten region is an instruction addressed to this agent and means nothing
pasted elsewhere, while the chip on screen says `@Reviewer`.

The Role's own pane replaced the neutral detail rows because a Role is one object
with one reading — which agent, which machine, which values it pins, and its
instruction — so the neutral rows were a second description that had already
drifted (printing stored ids raw, labelling the permission mode "Reasoning"). That
pane is desktop-only: the docked mobile strip is too narrow and has no hover to
preview with.
