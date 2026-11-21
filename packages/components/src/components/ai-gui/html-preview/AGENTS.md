# Conversation HTML previews

Parent component rules apply.

- Only a fence whose info string is exactly `html render` executes; a plain `html` fence
  stays source, because coding agents use it for HTML the user reads or copies. The
  `lody-visualize` MCP skill teaches the marker; keep its sandbox, theme-variable and
  height guidance in step with this renderer.
  [Decision](../../../../../../.agents/notes/implemented/feature/2026-11-21-inline-generative-ui-skill.md).
- Executable Markdown HTML requires parser-confirmed fence closure and an opaque-origin
  sandbox with only `allow-scripts`. Feedback is limited to validated bootstrap confirmation and height/error
  messages from the current iframe window and instance; it grants no host actions.
  Streaming completion must preserve the existing iframe.
- The document is generative UI inside the reply, not a file preview: it renders
  without preview chrome (source, reload, fullscreen or collapse controls).
- Injected theme and native-control defaults belong in the first fallback CSS layer
  with zero-specificity selectors and no `!important` or inline root styling.
  Sample the existing host's explicit `@lody/ui` token declarations; authored
  styles, including later author layers, must remain able to override defaults.
