# Conversation rhythm on themeable StyleX surfaces

Status: implemented
Translation: current

[中文](2026-10-03-conversation-rhythm-stylex.zh.md)

## Abstract

Conversation spacing combined virtual-row padding, activity-button padding and
invisible user actions in normal flow, making related content too far apart.
Fixed compact reserves then removed too much separation at the default size.
Semantic StyleX tokens now derive reading and round spacing from interface leading:
the default scene has 24px activity rows, 14px / 22px reading prose, a 36px
response gap and a 56px next-round minimum. Footer actions and next-user metadata
share that reserve; taller content can grow, and themes can override tokens without
changing authored text or font roles.

## Evidence and decision

The screenshot indicates a symptom, not computed CSS values. In the real completed
fixture at 1120 × 1500 and 14px text, original activity rows measured 26–28px,
bubble-to-response about 54px and quote-to-next-bubble about 86px. Hidden user Copy
actions still occupied a flex-stack row. Activity rows combined their own padding
with virtual-wrapper padding. Removing that duplication was warranted, but fixed
32px / approximately 56px reserves made the default view too dense. Increasing
only the outer reserves to 40px / 64px left prose at 14px / 20px: the view separated
messages more than it opened up reading. In the expanded four-row activity fixture,
the first bubble to actual prose was 140px, including 96px of activity and its gap.
The short fixture verified box distances but did not adequately expose wrapped-line
reading density.

The [conversation token group](../../../../packages/components/src/components/ai-gui/conversation.tokens.stylex.ts)
owns semantic spacing, not another global space or typography scale. It derives
`responseGap`, `roundGap`, paragraph spacing, activity pitch, list-item gap and
bubble padding from `@lody/ui` leading and shared space tokens. The
[rhythm Spec](../../../../specs/conversation-rhythm.md) owns formulas and size examples.
A fixed 40px / 72px adjustment was considered; proportional leading with floors
preserves hierarchy across all five interface sizes. The final balance separates
reading leading from interface leading: `readingLeading` derives from body leading
at 1.1 times (22px at 14px), while response/round reserves use smaller independent
multipliers (36px / 56px at 14px). User text and ordinary Markdown consume the reading
token; compact tool prose, code and UI controls retain their existing leading.
Explicit Markdown previews scale the token using the same typed division as font
size. Themes can change reading leading without changing macro reserves or code.
The redundant fenced-code `sectionGap` alias is consolidated into `surfaceGap`.

The user row positions actions in its response reserve. The first assistant row
adds no top padding, including when it is prose rather than a worked header.
Before an adjacent user turn, the last assistant row owns the round reserve.
For ordinary footers its minimum height subtracts the next user's metadata pitch
and gap, so actions and metadata fit within the intended distance. Metadata pitch
also accommodates the fixed 14px status icon at the smallest size. Without a
footer the last content row supplies the same reserve. A tail without a following
user gets only ordinary row padding. Edited-file cards, wrapped or extra actions,
and attachments can grow beyond the minimum; no fixed-height clipping is used.

Next-user role participates in the assistant-row cache identity, including user
placeholders. First/last boundary flags participate in memo comparison. Appending
or removing a follow-up therefore updates spacing without changing row keys,
and unchanged rows remain reference-stable. The scroll engine and outline
conversion are unchanged.

Message wrappers, bubbles, metadata, activity rows and Markdown elements consume
StyleX. Code and diff share the code-body component. The group aliases shared
radius and colours; unmatched existing CSS colour variables remain compatibility
bridges. Shiki palette interop, tables, Mermaid and diff-line-specific CSS remain.
User text keeps `pre-wrap`: removing authored blank lines would change copy,
search and content. The optical reading rail stays 4px; the
[typography decision](2026-10-03-interface-typography.md) remains the owner of text roles.

## Verification and limits

Nine focused unit suites pass (140 tests), covering virtual-row identity and boundary
updates, folding, activity, action insets, sender identity, copy, Markdown streaming
reparsing, idle rendering and share Markdown. The browser suites pass 20 tests:
all five sizes, light/dark and narrow layouts, measured
response/round gaps and list pitch, user blank lines, keyboard actions, code wrap,
no-footer and edited-file variants, native selection, ordered markers and existing
typography/preferences. A real scoped `createTheme` changes response/round reserves
independently to 48px / 80px, changes reading leading to 24px while code stays 18px,
and changes surface colours and margins. Additional static/streaming reading stories
use continuous mixed-script paragraphs; browser ranges verify actual wrapped lines
at 22px pitch.

The reading revision's before/after screenshots use the same synthetic long-prose
two-round story at 1120 × 1500, 14px, dark palette and expanded first activity group.
This compares the previous 20px / 40px / 64px balance with 22px / 36px / 56px.
No captured transcript is used. Components type checking runs in the existing
separate validation clone; source changes are copied from the primary worktree.

The primary worktree lacks dependencies and ACP submodules; root `pnpm check`
stops at missing `tsgo` after unmatched ACP filters, and root `pnpm format` stops
at missing `oxfmt`. All 13 changed TypeScript, TSX and CSS files pass a targeted
format check using the validation clone's formatter. A full repository build/check
is not established. Document checks still report links into absent submodules;
no changed document has a broken link and no SHA-protected topic was changed.
The Spec remains draft: implementation and passing tests do not grant human approval.

The selected-turn browser fixture retains the prior native-pointer selection
setup before establishing its exact range. This still asserts retained text and
connected nodes; it avoids a selection that disappeared even under the original
production styles before the writer update.
