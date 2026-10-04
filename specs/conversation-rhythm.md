# Conversation rhythm

Status: draft
Translation: current

[中文](conversation-rhythm.zh.md)

## Scenario

A person scans an agent's completed work, reads its answer and sends a follow-up.
Activity stays compact while the answer and next round have room to breathe.
Changing the interface font size preserves this hierarchy through the existing
[typography roles and leading](interface-typography.md).

## Spacing contract

Conversation surfaces consume one semantic StyleX variable group. Shared space,
radius, colours and typography remain owned by `@lody/ui`. Fixed optical insets
and icon gaps keep the existing grid; reading and round spacing follow the active
interface leading. Themes may override semantic tokens in a subtree. This adds
no theme picker or persistence.

Let `B` be interface body leading and `S` be subheadline leading, in pixels.
Reading prose uses its own themeable leading `R = B × 1.1` (14px / 22px at Default).
User bubble text and ordinary Markdown use `R`; compact tool prose and code keep
subheadline leading. Controls retain their interface roles. Message reserves follow
`B` independently, so increasing reading leading does not automatically push rounds
farther apart.

| Semantic distance | Rule | 12px text | 14px text | 16px text |
| --- | --- | ---: | ---: | ---: |
| Reading line height | `B × 1.1` | 18.9 | 22 | 25.1 |
| Paragraph gap / bubble block padding | `max(12, B - 8)` | 12 | 12 | 14.9 |
| Rich surface gap | `max(16, B - 4)` | 16 | 16 | 18.9 |
| Activity minimum pitch | `max(24, S + 6)` | 24 | 24 | 26.6 |
| Single-line list pitch | `max(24, R + 2)` | 24 | 24 | 27.1 |
| User → response | `max(32, B × 1.8)` | 32 | 36 | 41.1 |
| Answer → next user | `max(48, B × 2.8)` | 48 | 56 | 64 |

Values in the table are rounded for reading; CSS retains fractional pixels.
All five interface sizes (12–16px) follow these rules. Activity rows may grow
for wrapped content; virtual wrappers add no process padding. Compact tool prose
keeps its own tight paragraph/list rhythm.

The user row owns `responseGap` below the bubble, including hover/focus actions.
The first assistant row adds no second top gap. The last assistant row owns
`roundGap` when the following turn is a user, including an unhydrated user turn.
The answer's ordinary footer actions and next user's metadata fit inside that
reserve, rather than adding independent gaps. Without a footer the last content
row reserves the same distance. At the conversation tail no next-round reserve
is added. Edited-file cards, additional or wrapped actions, and attachments may
naturally exceed the minimum; they must remain accessible and never overlap.
Distances use component boxes, not visible glyph bounds.

The Markdown renderer owns paragraph and list spacing; fenced code and other
rich surfaces use `surfaceGap`. Rich content retains the existing reading rail.
User avatars align with the bubble's first line; metadata stays above the bubble.
User text preserves authored whitespace, chips, copy/search and native selection.
Folding retains answer visibility, stable row keys and the existing scroll engine.
Static and streaming Markdown share element styles and reading leading.
Acceptance includes automatically wrapped multi-line CJK/Latin paragraphs, not
only single-line lists or component-box distances.

## Evidence

- [Tokens](../packages/components/src/components/ai-gui/conversation.tokens.stylex.ts),
  [shared surfaces](../packages/components/src/components/ai-gui/surface.ts).
- [Synthetic stories](../packages/components/src/stories/AssistantTurnAlignment.stories.tsx),
  [browser coverage](../packages/components/tests/e2e/interface-typography.spec.ts).
- [Decision and verification limits](../.agents/notes/implemented/simplification/2026-10-03-conversation-rhythm-stylex.md).
