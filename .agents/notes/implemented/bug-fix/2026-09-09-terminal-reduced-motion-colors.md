# Resolve terminal colors without transitions

Status: implemented
Translation: current

[中文](2026-09-09-terminal-reduced-motion-colors.zh.md)

## Abstract

With reduced motion enabled, the terminal's synchronous CSS color probe can
return the background color for its foreground, cursor, and ANSI palette,
making a working terminal appear blank. The resolver disables transitions on
the disposable probe before it enters the document. Chromium reproduces the
failure on the unfixed resolver and passes after the fix in both motion
modes, including a dark-to-light palette change. The global accessibility
styles and terminal lifecycle remain unchanged.

## Decision

`buildTerminalTheme` owns CSS-to-xterm color resolution for both terminal
creation and theme updates. The global reduced-motion rule sets a nonzero
`transition-duration` on every element; the probe's default transition property
is `all`. Each immediate computed-style read can therefore observe the start
of a color transition instead of the requested token.

Set `transitionProperty` to `none` on the probe before appending it. Changing
the global reduced-motion rule would affect unrelated components, while
waiting for a transition would make a synchronous resolver asynchronous.

## Evidence and limits

The Playwright regression uses the real stylesheet and resolver through the
existing Storybook server, with synthetic CSS tokens. It checks foreground,
cursor, red/green ANSI colors, alpha selection color, a palette change, and
probe cleanup under `reduce` and `no-preference`.

Before the fix, only the reduced-motion case fails; after it, both cases pass. This is Chromium renderer verification, not a rebuilt desktop
release or verification of every terminal renderer and operating system.
