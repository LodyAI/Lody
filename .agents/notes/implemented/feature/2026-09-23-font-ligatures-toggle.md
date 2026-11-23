# Appearance font ligatures toggle

Status: implemented
Translation: current

[中文](2026-09-23-font-ligatures-toggle.zh.md)

## Abstract

Appearance now has a boolean Font ligatures switch, default on, in its own card
after the Terminal section on every platform. It writes `--lody-font-ligatures`
so conversation, code, and tool output follow one preference. Ghostty-style
`font-feature` strings and a Terminal-group placement were rejected because the
setting is not an OpenType DSL and is not a Terminal font/size control. Local
xterm and Monaco stay unchanged.

## Decision

The product need is turning ligatures off for `!=`, `=>`, and `===` in
conversation code. Existing appearance preferences are local Jotai atoms plus one
CSS variable; a boolean fits that shape. A free-form `font-feature` field would
need parsing, validation, and a control the Appearance page does not have, while
DOM CSS, Monaco, and xterm do not share one OpenType channel.

Placement is a separate card after Terminal, not inside the Terminal group.
Terminal font and size only drive the Appearance preview and local xterm; the
ligature surfaces are conversation Markdown and the DOM tool-output card. Putting
the switch in the Terminal group would describe the wrong owner. Helper copy is
"Applies to conversation, code, and tool output." The row is not Electron-only:
web Appearance and mobile Appearance show it too.

The controller writes `contextual` or `none` onto `--lody-font-ligatures`. CSS
that previously hard-coded `font-variant-ligatures: contextual` now reads that
token. Monaco `fontLigatures: true` and xterm canvas rendering are out of scope:
the former is the file viewer, the latter needs a ligatures addon.

## Verification

The appearance suite asserts the row is visible outside Electron, sits after
Terminal when that section is present, defaults on, and can be turned off. The
controller suite asserts the CSS variable updates on every platform and that
non-boolean stored values stay enabled. Not exercised here: packaged native-app
checks, live ligature shaping of a specific font face.
