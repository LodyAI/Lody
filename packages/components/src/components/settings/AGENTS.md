# Settings surfaces

Parent `AGENTS.md` files also apply. `CLAUDE.md` is a symlink to this file; edit
`AGENTS.md` only.

- A settings row (`compact-layout.tsx`) is one grid: the label column takes the
  remaining space and the control column hugs its content. Never size either column
  from a viewport breakpoint — settings render in a panel far narrower than the window,
  and the panel clips its overflow, so a `md:`-width label column silently hides the
  control.
- Agent configuration lives in `agent-config-dialog.tsx` plus `env-vars-textarea.tsx`.
  DeepSeek Harness official vs custom endpoint is dialog form state only: persist
  `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` (official always writes
  `https://api.deepseek.com`) and never a new AgentConfigMeta field. Model ids come from
  the endpoint's OpenAI-compatible discovery response during live verification; do not
  add a parallel manual catalog field. Additional env cannot override either connection
  key, and changing endpoint or credential invalidates the dialog's prior live
  verification.
- Keep optional three.js/R3F usage behind the lazy usage-calendar module so lightweight
  and SSR consumers do not evaluate its renderer graph.
- The Codex reset forecast chip in the provider row must not fetch on mount and must
  pass `nestedInDialog` for its dialog: [../codex-reset/AGENTS.md](../codex-reset/AGENTS.md).
