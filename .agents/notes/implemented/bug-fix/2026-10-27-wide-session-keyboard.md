# Apply the native keyboard offset once in wide sessions

Status: implemented
Translation: current

[中文](2026-10-27-wide-session-keyboard.zh.md)

## Abstract

A wide native session lifted its composer by two keyboard heights: both the
workspace root and the composer applied the native offset. The wide workspace
now owns that lift, while a mobile session drawer still lifts its composer and
question form itself because its portal sits outside the workspace. This keeps
the controls above the keyboard without wasting a second keyboard-sized gap.

## Decision and evidence

An authenticated native simulator session crossed from a phone layout to the
wide workspace on expansion. With the keyboard open, the composer stood far
above it because the root padding and composer margin both consumed
`--native-keyboard-height`. Mobile sessions need the margin: their full-screen
drawer is portalled outside the root. The same distinction applies to the
question form which replaces the composer. Wide landing and session views retain
root padding; bottom sheets retain their independent positioning contract.

This complements the separate [side-drawer resize fix](2026-10-27-ios-drawer-resize.md).
The user session and draft remain owned by the existing layout and navigation.
Five drawer, composer and permission-prompt suites pass (105 tests), along with
components typechecking and changed-file lint. In the native Duo simulator, the
wide composer sits immediately above the docked keyboard; folding restores the
same chat to a usable single column and its composer clears the reopened keyboard.
The keyboard dismisses when the layout family changes. A WebKit regression test
checks that a wide landing composer moves once when the native keyboard offset
changes. Physical devices, split view, question-form keyboard behavior and
floating keyboards need separate acceptance.
