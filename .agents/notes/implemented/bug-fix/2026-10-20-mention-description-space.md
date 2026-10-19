# Use available space for mention descriptions

Status: implemented
Translation: current

[中文](2026-10-20-mention-description-space.zh.md)

## Abstract

Skill descriptions stopped after five lines even when the detail pane had unused
space. The pane now reserves its heading, metadata and bottom facts, including the
skill path, and gives the remaining height to the description. The number of
visible lines follows that space; excess text ends with an ellipsis. The detail
pane does not scroll or grow the menu.

## Decision and scope

This replaces the five-line description cap and neutral-pane scrolling in the
[mention menu design](../feature/2026-09-25-composer-mention-menu-v2.md#design-review-round-2).
The candidate list still sets the pane height. Its content is a bounded flex
column: fixed heading and metadata, flexible description, then fixed bottom
facts. A ResizeObserver measures the description slot and divides its height by
the computed line height to choose the whole-line clamp. This also responds to
font-size and list-height changes. Overflow clipping keeps the pane stationary
under wheel input. The separate Role pane retains its own layout.

## Verification

All 42 existing mention-menu tests pass, as do scoped Oxfmt, Oxlint, and component
typechecking. The owning Playwright suite now covers short and long skill lists
at 12px, 14px and 18px font settings: paths stay visible, descriptions fit their
slots, a tall list exposes more than five lines, and wheel input cannot scroll
the pane. That regression test passes. An isolated browser render of the actual
detail component also passes nine height/font-size combinations (168/300/440px
pane heights and 12/14/18px font settings).
