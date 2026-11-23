# Workspace member avatars in desktop settings

Status: implemented
Translation: current

[中文版](2026-10-21-workspace-member-avatars.zh.md)

## Abstract

Desktop workspace settings showed members only by name and email even though the
member records already include profile images. Members now display the existing
32px circular `UserAvatar` beside their identity text, with initials or the person
glyph when no image is available. The avatar belongs to the label column of the
shared settings row, preserving its single role control and permission behavior.
This restores visual identification without introducing another member data source.

## Decision

The [settings row grammar](2026-09-26-settings-row-grammar.md) removed avatars
together with bespoke member cards and multiple actions. This request restores
the identity mark while retaining `CompactRow` and its single role menu. An
optional `leading` slot groups the avatar with the label and helper inside the
existing label column; rows without it keep their existing markup.

Desktop uses `member.user`, the same source and avatar component already used by
mobile. Cached images and fallback rendering remain owned by `UserAvatar`.
Member sorting, role editing, removal permissions and network behavior do not change.
The owning Storybook fixture includes a synthetic image and members without images.

## Verification

- The desktop workspace story renders images and initials in both palettes, with
  32px avatars centered against the two-line identity text. Its role menu still
  opens, and a 480px desktop pane has no horizontal overflow.
- The existing account avatar suite passes all four cases.
- Packaged Electron behavior was not checked.
