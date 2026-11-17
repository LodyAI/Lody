# Conversation HTML previews

Parent component rules apply.

- Executable Markdown HTML requires parser-confirmed fence closure and an opaque-origin
  sandbox with only `allow-scripts`. Feedback is limited to validated bootstrap confirmation and height/error
  messages from the current iframe window and instance; it grants no host actions.
  Source/fullscreen and streaming completion must preserve the existing iframe.
- Injected theme and native-control defaults belong in the first fallback CSS layer
  with zero-specificity selectors and no `!important` or inline root styling.
  Sample the existing host's explicit `@lody/ui` token declarations; authored
  styles, including later author layers, must remain able to override defaults.
