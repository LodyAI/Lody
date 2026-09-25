# PR tab as a document: title first, one state line, threads that quote their code

Status: implemented
Translation: current

[中文版](2026-09-25-pr-tab-document-layout.zh.md)

## Abstract

The side-panel PR tab spread one pull request's identity over four blocks: a
status chip with the number in the header, two labelled branch rows, a title
that repeated the number, and a meta line. Its review threads were a bordered
Tailwind card inside a fill region inside the activity card. The owner asked
whether to keep this "physical" look or follow GitHub or Linear. The tab now
takes its structure from Linear and GitHub and keeps its materials from
`@lody/ui`. The title leads. One line gives the state as a word plus
`base ← head`, and one line gives author, age and size. Activity rows read as
sentences, and a thread quotes the code it is about. Chips that only decorated
are gone. The merge action stays top right as one quiet joined
control, which needed a new `ButtonGroup` in `@lody/ui`; checks and mergeability
became one card below it. The Buttons still stand up and the activity is still one card with
ruled rows, as the package rules require.

## Problem

Measured on the `Sessions/PrTabView` stories before the change:

- The number appeared twice (the header chip and after the title), and the
  status existed only as the chip's colour.
- Base and head took two rows with the labels 目标/源. Each branch was a chip,
  so the header, branch rows and title read as three bands of chips before any
  content.
- The title was 1.15em, about the size of a markdown `##` inside the body. A
  PR template (Related issue, Problem, …) therefore competed with the title and
  pushed checks and reviews off screen.
- A review's thread had three edges: the activity card, a 3% region, and the
  shared `GitHubCommentThread`, which still drew a Tailwind `border` + `shadow-xs`
  card. Its header had two decorative glyphs (GitHub, speech bubble), an
  untranslated "1 comment", and a second "outdated" badge that duplicated the
  PR tab's own. The diff-viewer draft card restyled `Textarea` through
  `className`, which `packages/components/AGENTS.md` forbids.

## Decision

The information architecture comes from Linear and GitHub, and the materials
come from Lody.

- **Pure GitHub rejected.** Primer's boxes are 1px borders. `@lody/ui` has no
  border token, and edges are shadows, wells and fills.
- **Pure Linear (flat) rejected.** When settings went flat, the owner rejected
  it because every other layer has material. See
  [settings rhythm](2026-09-25-settings-rhythm-and-image-peek.md).
- **Kept from Lody:** Buttons stand up; the checks and the activity are each one
  card with ruled rows; a thread inside a card is a fill region, not a second
  card.
- **Taken from the references:** the title is the page heading (1.4em). A
  state pill with a word (GitHub) is the one place the state is spelled out.
  Refs are written `main ← head` on the same line, as git tools do; the base
  is quieter because it is where the branch lands. The header is a breadcrumb,
  `repo / #n`, so the number appears once. Activity rows read as sentences:
  avatar, **login**, verb, time. Only a verdict (approved, requested changes)
  takes a colour. Bodies align under the name, not under the avatar.
- **Threads away from the diff quote their code.** In the PR tab a thread shows
  `path:line` (the path truncates from the left so the file name survives) and
  the tail of GitHub's `diff_hunk`. GitHub cuts that hunk at the commented line,
  so the excerpt is its last four lines, or the whole range (up to eight lines)
  for a multi-line comment. Beside its own line in the diff, the thread keeps
  the comment count and shows no excerpt. `GitHubCommentThread` takes
  `surface: 'card' | 'inset'` and `showAnchor`, and is now StyleX.
- **Long descriptions fold.** A body taller than 22em × 1.25 folds to 22em
  behind a mask and a "Show more" ghost button. The height is measured with a
  ResizeObserver rather than guessed from the text, and the fold never hides
  only a line or two. The description still scrolls with the panel, not in its
  own scroller.
- **The action stays at the top; its reason moves into one card.** Before,
  "can this merge?" had three answers: a black split button in the header, a
  checks card, and a separate conflict/blocked notice. The owner called the
  header cluster "reasonable and not reasonable at once", mainly because it
  was too heavy.
  - Tried first: moving the action into the card below. The owner rejected it
    because they should not have to scroll to merge.
  - Adopted: the next step stays top right as one quiet `ButtonGroup`. The
    command and its chevron are segments of one shape, and both are
    `secondary` rather than black `primary`.
  - The merge glyph takes the checks' colour (green passed, red failed, amber
    running), so the button says whether merging is wise before anything is
    read.
  - The chevron holds the merge method and Close. Closing is never the next
    step, so it never gets a button of its own.
  - The checks card became the merge card. It has a verdict heading (ready,
    conflicts, blocked, checking, draft, merged, closed), a checks summary, and
    the expandable runs. It replaces the separate notices. A PR that can merge
    past failing checks that are not required gets a warning mark, not a green
    tick.
- **`@lody/ui` gained `ButtonGroup`.** There was none; every split action in
  the product was two Buttons with a 2px gap. That is exactly why the old
  header read as two black blocks. Segments keep their outer corners and
  square the shared ones through `:first-child`/`:last-child` longhands, which
  win over the size's `borderRadius` shorthand. They sit 1px apart, so the
  seam is two edges meeting and needs no border token. The other split
  buttons, such as the info-bar merge in `pr-merge-button.tsx`, are not
  migrated here.
- The inline draft in the diff (`SessionCommentDraft`) became the same card:
  it has a standard `Textarea` well and Cancel/Comment buttons, and the close
  glyph is gone because Escape and Cancel remain.

The landing embed (`embedded`) keeps its slim bar with `PullRequestBadge` and
the same header action; the title block, merge card and activity change there.

## Verification

- `tests/pr-tab-view.test.ts` covers the excerpt boundaries (single line, range,
  file-level). It checks that the number appears once and the state pill says
  `merged`. It checks that a review's thread renders under the review with its
  path, line, excerpt and comment. It also checks that an outdated thread opens
  collapsed to a preview and expands. It checks that the merge action is a
  header `ButtonGroup` while the verdict is in the card, that a merged PR with
  no branch left has no header action, and that a conflict is named in the
  card with Resolve conflicts in the header. `packages/ui/test/button.test.tsx`
  checks that a grouped button carries segment classes a lone one lacks.
- Screenshots were taken in Chromium via Storybook of the open (CI failed),
  merged at 380px, long-body fold, light and dark, and zh_CN stories, plus the
  diff-viewer `SessionComment/GitHubThread` stories.
- Not verified: an Electron session with a live GitHub PR. The stories use
  synthetic hunks.
