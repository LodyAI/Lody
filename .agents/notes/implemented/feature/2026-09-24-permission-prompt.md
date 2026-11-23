# A permission request is one prompt in the composer's place

Status: implemented
Translation: pending

PR: https://github.com/LodyAI/Lody/pull/923

## Abstract

The permission UI asked every request the same way: a gray "Permission
Required", the tool title in small type, and the options as identical dotted
rows, so `rm -rf` read like "Read file". It showed each pending request twice —
inline in the tool card and in the floating card — with both live, and it had no
keyboard path, no focus handling, and no visible failure. The owner asked for a
zero-based redesign from the user's side. A request is now one prompt in the
composer's place: the provider's own heading and reason, exactly what would run
or touch, and the provider's own answers, one request at a time. Contract:
[answering a permission request](../../../../specs/permission-requests.md).

## What the survey found

- Claude and Codex send a heading ("Run command?", "Ready to code?", "Make
  edits?") and a reason in `_meta.permission`, stored in history and never read.
  Claude marks risky calls `defaultToNo`; Codex puts option descriptions in the
  option `_meta.permission.description`.
- Option names are long and specific ("Yes, and don't ask again for `pnpm
install` commands", "No, and block this host in the future"). Kinds are ACP's
  four plus Lody's `deny`.
- `rawInput` is not stored, and edit requests lose their `diff` blocks before
  storage (`acp/tool-call-history.ts`). Execute and search keep a
  `terminal_command` block; file kinds keep `locations`.
- Several requests can be pending (a set per session in the CLI); the composer
  and queue are hidden while any is pending, which also hid Stop.
- Answer failures only reached `console.error`.

## Decision

- **One live surface.** `FloatingPermissionRequest` is the only place a request
  is answered. `PermissionRequestBlock` in the conversation renders a one-line
  "Waiting for your answer" while pending (the share page keeps "Waiting for the
  author"), and the settled one-line record afterwards. The old
  `PermissionRequestCard` and its collapsible plan-approval variant are gone.
- **`PermissionPrompt`**, presentational, shared with the onboarding tour: heading
  (provider's, else a question from the tool kind), reason, subject (command with
  directory, paths, or title; none for a plan), and the options as full-width
  rows marked by kind (✓ once, ✓✓ always, ✕ refuse, ⊘ always refuse).
- **Keyboard without accidents.** Arrows walk from the suggested answer; Enter or
  Space answers the focused row; Escape refuses once. Enter on the prompt itself
  does nothing: the prompt replaces the composer, and an Enter meant for a
  message must not approve anything. Digit shortcuts were left out for the same
  reason — a person mid-sentence types digits.
- **The suggestion is never "always".** Widening what the agent may do from now
  on is a deliberate choice, not a default; `defaultToNo` moves the suggestion to
  the refusal.
- **One at a time**, with "n of m" and previous/next; answering brings up the
  next. **Stop** is in the prompt. A failed answer shows an alert and the prompt
  stays answerable.
- Presentation logic lives in `lib/permission-request-presentation.ts`.
- **Owner review: less.** The first build stacked a kind icon, a mark on every
  answer (✓ ✓✓ ⊘ ✕), a key-hint footer and a text Stop button, with three
  different left edges. The owner found it redundant. Now every block shares
  one text edge; answers carry no marks (each already starts with Yes / No /
  Allow); prose titles that restate the heading are dropped; the only key cap
  is `esc` on the refusal; Stop and "n/m" sit at the end of the heading line.

## Second owner review: the system's own anatomy

The owner found the prompt still unlike the design system. It was a bespoke
card: answers as list rows with a selected fill, and type sizes of its own. The
system already has the shape for a question that needs an answer — the
AlertDialog: a `headline` title and one sentence, the body, and the answers as
Buttons in a footer, from the end, affirmative last, stacked in reverse when
narrow. The prompt is now that, on the card rung (the composer's): answers are
Buttons (controls stand up), the suggestion is the primary one and comes last,
the subject is a region block of the card, the type is the system's steps, and
Stop is the corner icon a dismissible panel carries. Answers stack full width
when any is longer than 24 characters or there are more than three.

## Third owner review: the composer's scale

As an AlertDialog the prompt was an action sheet: a 16px bold title and three
full-width 48px bars dominating the conversation. A dialog's anatomy is for a
panel that takes the page; this is an inline decision in the composer's place.
It now has the composer's scale: a 14px title, a 12px reason, and one row of
small buttons — refuse once (secondary) and the suggestion (primary, last) at
the end, and any standing answer ("Yes, and don't ask again for …") as a ghost
button at the start, the provider's words whole but not competing.

## Fourth review: one kind of answer, in one place

Splitting the answers into a row of buttons and a line of ghost "standing"
answers left the ghosts floating as loose text above the buttons, and the eye
could not tell where the choices were. The answers are now one column of small
secondary buttons in the provider's order, labels from the start, the
suggestion primary: every answer the same object in one place. The conversation
steps lost their icons in the same pass — the verb says what kind of step it is.

## Fifth review: split buttons

A column of full-width buttons still read as a stack of bars. The answers now
follow the pattern the agent tools converged on for inline approvals (VS Code
Copilot, Zed, Cursor): one row at the end with a split button per family —
refuse, then allow. Each shows its one-time answer, the suggestion primary, and
its chevron menu holds the standing answers ("Yes, and don't ask again for …",
"No, and block this host …"), where a long provider sentence reads naturally.
The row stays compact whatever the provider sends; the arrows walk the two
shown answers and Escape still refuses once.

## Alternatives not taken

- **Buttons in a row** (Allow / Always / Deny). Provider names are sentences; a
  button row truncates exactly the words that say what "always" covers.
- **Enter approves the suggestion immediately**, as terminal agents do. In a
  terminal the prompt appears where you are already answering; here it replaces
  a text field the person may be typing in.
- **Keeping the composer with "reply instead"**. Sending a message while a
  request is pending queues behind the blocked turn; there is no free-text
  answer to a permission in ACP. Refusing (and Codex's "tell Codex what to do
  differently") ends the wait, and the composer returns.

## Follow-ups found, not done here

- Store edit diffs (bounded) so the prompt can show the change, not just paths.
- The iOS Live Activity picks `allow_always` when present
  (`live-activity-permission-action.ts`), against this design's rule.
- Lody's Grok "Always Approve" auto-answer does not skip `switch_mode`, though
  the Grok README says plan decisions stay interactive
  (`apps/cli/src/agent/lody-acp-extension.ts`).
- The 20-minute timeout is invisible until the request is withdrawn.

## Verification

- `tests/permission-prompt.test.tsx` (12 tests): provider heading and subject,
  kind fallback, Escape refuses once and never permanently, Enter on the prompt
  answers nothing, arrows land on the suggestion, `defaultToNo`, focus is not
  taken from a focused field, sending disables every answer, failure is shown.
- Components typecheck. Not verified visually, at the owner's request; the
  `Sessions/PermissionPrompt` stories cover each provider's real option set.
