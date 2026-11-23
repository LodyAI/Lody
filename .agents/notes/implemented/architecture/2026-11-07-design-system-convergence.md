# Product design-system convergence

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875)

[中文](2026-11-07-design-system-convergence.zh.md)

## Abstract

The Tailwind migration preserved effective styles, including legacy opacity and surface overrides that did not follow the product design system. This follow-up adopts the existing control, field, popup and card rules in their real owners rather than preserving those overrides. Disabled opacity has one default owner, while a new media contrast pair covers a previously unnamed image-overlay role. Appearance changes are intentional design-system changes; they remain visible in Before/After reports and do not turn historical migration differences into passes.

## Ownership

| Concern                   | Owner and contract                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disabled control          | `control.disabledOpacity`, default 45%. Button and popup read it directly; field, disclosure and toggle keep their public family aliases. Dim once, including decorated input text, rather than multiplying parent, glyph and control opacity.                                                                                            |
| Field                     | One well and one focus edge. A bare input inherits a parent-owned surface; values, placeholders and icons use their existing family roles. Controls use the 13/18 type step, while message prose follows the body step and conversation-font preference.                                                                                  |
| Composer / message editor | Card material, no perimeter border. The owner draws the focus/drop ring; the bare input explicitly draws none, including against the shell's global focus styles.                                                                                                                                                                         |
| Popup / command           | The containing Dialog or Popover owns its rung. Search uses a well; rows and metadata read popup roles without a second surface or independently chosen alpha.                                                                                                                                                                            |
| Image overlay             | The independent `media.scrim` / `media.label` pair: black 60% under white text. It is theme-independent and restricted to noninteractive captions, progress labels and scrims over external images. On a white image its contrast is about 5.74:1. Ordinary controls keep their component material.                                       |
| Mention cover             | An opaque backdrop plus the well's translucent fill as a second native background layer. This reproduces the actual well without compositing a second translucent cover over the native glyph. Card owners reset the overlay; the shortcut form publishes its actual dialog backdrop. No approximate 5% mix or per-alpha token is needed. |

The browser toolbar's URL and intrinsic-width connection status share Input's one well and focus owner through its trailing slot; refs, native events and input style callbacks stay on the real input. Annotation mode uses the pressed Toggle material with an accent mark. Draft, thread and peek chrome use popup roles and standard controls; editable text keeps the field well. Author hues and shared review-marker colors identify domain data. Pin placement, viewport clamping, anchor resolution, submission and URL restoration remain unchanged.

Context choices use the existing Tabs track and indicator. An unavailable context's help or connection entry remains a working ghost Button, not a falsely dimmed disabled tab; it preserves the original tooltip/connection and controlled-selection behavior. Truly disabled history rows use the shared 45% role. The retained `tone` prop does not create a second local palette over the actual theme owner.

Family aliases resolve where they are declared. The shared disabled default does not promise that an arbitrary subtree override of `control` rebinds every family; existing family theme APIs remain available. The product palette is published on the document root, and forced palettes must use the existing theme owners that redeclare dependent family tokens.

The scope includes shared UI primitives, legacy Sidebar/Command/Emoji/mention owners, Composer and its real rich-input callers, PR merge controls, and audited native disabled controls. It preserves refs, handlers, keyboard and IME behavior, selection, response-driven state and responsive layout. Replacing decorative borders with material, standard control type, and standard grouped-button seams can change geometry; those changes are recorded instead of padded away.
