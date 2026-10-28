# Agent notices drop the ring for a soft well

Status: implemented
Translation: current

[中文](2026-10-27-agent-notice-soft-well.zh.md)

## Abstract

`agent_warning` and `chat_failed` shared a full-width tinted card with a 0.5px
tone ring. That ring made the notice the only outlined block in a conversation
built from soft fills, so it read as chrome dropped on top of the prose. The
notice is now the same kind of surface as a user bubble or code block: a
~4.5% tone well with no ring, a centered glyph/label header, 13px subheadline
type, and the message at the well's leading edge. Always-open, full-width,
copy, and retry behavior are unchanged. The trade-off is a quieter warning; the
tone on the glyph and label and the tint carry the status.

## Decision

The user approved option A on the Ryugi decision artboard after comparing a soft
well, a tone rail, and an inline sentence, then commented that the glyph and text
must align, the description must not be indented, and the failure copy action
must remain.

`AgentNoticeBanner` now renders:

- A header row with `alignItems: center`: 14px glyph, 13px/18px medium label,
  and at most one trailing owner (retry when present, otherwise copy).
- The detail as a block at the well's leading edge (`padding-inline: space[3]`),
  never indented under the label; 13px/20px `--muted-foreground`.
- A 4.5% tone fill (`--destructive`, amber, or `--muted-foreground`) with no
  ring or border. The label keeps the tone colour; the body stays on the muted
  prose ramp.
- Copy on the header only when it is the sole trailing control; a retry action
  keeps the header and copy takes its own footer row.

The type moves from the footnote role to the subheadline role, matching the
conversation's activity timeline instead of reading smaller than its neighbours.

## Alternatives

- **Tone rail** (2px left rule, no fill): quieter and more editorial, but the
  conversation has no left-rule primitive; it would add a new material just for
  failures.
- **Inline sentence** (no surface, label and message on one line): closest to the
  transparent timeline, but a long provider payload becomes an undifferentiated
  paragraph and the failure loses its boundary.

The ring was also considered with a neutral label. It still left the notice as
the only outlined block, so it did not solve the material mismatch.

## Verification

Storybook captures at 845×760 (desktop dark and light), 760×250 (long and
multi-line agent text), and 390px (warning and failure) show the implemented
well; the Ryugi artboard check reports zero warnings. Component typecheck passes,
the full `@lody/components` suite passes (622 files, 6262 tests), and a Playwright
click on the phone failure's copy action read the expected `Error details:`
report from the clipboard. Not verified: a packaged Electron pass and native text
selection over the notice. The old full-width note still owns the width and
folding rationale; its ring/fill sentence is superseded by this note.
