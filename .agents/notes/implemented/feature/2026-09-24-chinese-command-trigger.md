# Chinese command-menu trigger

Status: implemented
Translation: current

[中文](2026-09-24-chinese-command-trigger.zh.md)

## Abstract

The command menu required an ASCII slash, forcing Chinese-input users to switch
punctuation. The composer now registers `、` alongside `/`, and the registry
routes both to the same candidates. Selection keeps the canonical slash token
and existing whole-prompt restriction for commands. Shortcuts keep their inline
behavior; unselected text is unchanged.

## Decision and evidence

Treat the new punctuation as a menu alias rather than rewriting all composer
text, so ordinary prose and the downstream command protocol remain unchanged.
The composer owns trigger availability and whole-prompt gating; the registry
owns candidate routing. Shortcut invocation uses the existing slash-menu source.
See the [behavior draft](../../../../specs/command-mention-triggers.md).

The existing composer test suite covers both prefixes, filtering, keyboard
selection, and rejection of mixed prompts. Native Chinese IME interaction still
needs manual verification; synthetic input tests do not establish OS behavior.

## Verification

The focused composer and registry suites pass all 37 tests. `NODE_ENV=test pnpm check`,
`pnpm format`, and `pnpm run docs check` pass. The components suite passes all
4015 tests across 492 files. Native IME testing remains manual.

PR: [#934](https://github.com/LodyAI/Lody/pull/934).
