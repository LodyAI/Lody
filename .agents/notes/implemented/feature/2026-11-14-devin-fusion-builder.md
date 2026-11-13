# Devin Fusion builder over advertised model pairs

Status: implemented
Translation: current
Language: [中文](2026-11-14-devin-fusion-builder.zh.md)

## Abstract

Devin advertises Fusion as one `model` value per lead–sidekick pair, so Lody's
model menu listed dozens of `Fusion (… + …)` names with no way to choose a lead,
sidekick, lead effort and Fast Mode the way Devin Desktop does. A no-inference ACP
probe of the official runtime found no independent Lead or Sidekick option: pairs
are reachable only through the advertised values, while lead effort
(`thought_level`) and Fast (`speed`) are real per-model options. Lody adds a Fusion
dialog that structures the advertised values into Lead and Sidekick choices,
disables pairs Devin does not offer, and applies exactly one advertised model value
plus that model's own effort and Speed through the composer's existing edits; the
next turn applies them and Devin's reported state is the confirmation. Arbitrary
pairing stays blocked until Devin exposes independent controls. A real prompt
reached the execution path and died on an exhausted quota — Devin's own turn
stats named the configured pair with the applied effort and Fast — so the
configuration is verified through execution admission, while actual lead/sidekick
turn content remains unverified.

## Evidence

Conditions: macOS arm64, Devin CLI 3000.12.28 (the adapter's pinned runtime),
`acp-extension-devin` 32e125a, an authenticated account. Only `initialize`,
`session/new` and `session/set_config_option` were sent, directly to `devin acp`
and through the adapter, with `DEVIN_SESSIONS_DIR` set to a scratch directory. No
prompt was sent and raw traffic stayed local.

- `session/new` reports `mode`, `model` (a flat select of 145 values, 88 of them
  `fusion-*`), `thought_level` (category `thought_level`) and `speed` (category
  `model_config`, `standard`/`fast`). There is no lead or sidekick option, and each
  model option's `_meta` carries only `cognition.ai/supportsImages`.
- A Fusion value is `fusion-<lead and its default effort>-sidekick-<sidekick>`,
  named `Fusion (<lead> <effort>[ Thinking] + <sidekick>)`. Nine leads and ten
  sidekicks give 90 pairs; the two missing ones pair a lead with its own model as
  sidekick. A sidekick's effort is part of the sidekick value (`SWE-2 Medium`,
  `SWE-2 High`), so there is no separate sidekick effort.
- Selecting a Fusion value returns the full option list with that lead's ladder
  (`low` … `max`) and the default from its id. Setting `thought_level` or `speed`
  keeps the model value; selecting another pair resets the effort to that pair's
  default. The adapter declares 17 pairs without Fast; the two probed (Claude
  Fable 5.2 and Claude Sonnet 5.5 leads with SWE-2 Medium) omit `speed` entirely.
  An unadvertised value fails with `-32602 Invalid params` and changes nothing.
  No `config_option_update` notification followed these calls.
- Devin's private model catalog cache describes 795 Fusion configurations on Lead,
  Effort, Sidekick and Fast Mode axes, so Devin's own picker is also a view over
  enumerated configurations. Lody does not read that cache.
- A `session/prompt` after applying `fusion-gpt-6-sol-high-sidekick-swe-2-medium`
  plus `thought_level=medium` and `speed=fast` failed with `-32011`
  ("daily usage quota … exhausted"), and the `_cognition.ai/turn_stats`
  notification reported `cause: quota_exhausted` with
  `modelLabel: "Fusion (GPT-6 Sol Medium Thinking Fast + SWE-2 Medium)"` — the
  runtime's own label renders the pair with the APPLIED effort and Fast (the id's
  `high` is only its default), confirming the configuration reached execution
  admission. Zero tool calls ran; no real turn content was produced.

## Decision

- `lib/devin-fusion.ts` builds the catalog only from options whose value and name
  both have the Fusion shape; every other option stays in the ordinary Model list.
  A lead label drops its default-effort word only when the id and the name agree.
  Lookups return advertised values only: an unadvertised pair has no value,
  disables Apply and says that Devin's ACP does not offer the combination.
- Effort and Fast come from the selectors the composer builds for that pair's
  model (`useAcpModelSelectorResolver`): recorded options or the adapter's
  declaration, and nothing when Lody would only borrow another model's controls. A
  pair change keeps an offered effort, otherwise resets it with a visible notice,
  and turns Fast off where the pair has no `speed`.
- Apply writes the model value, `thought_level` and `speed` through the ordinary
  composer edits. The dialog says whether Devin's runtime baseline
  (`acpRuntimeConfig`) already matches; otherwise the change applies from the next
  message, where the CLI applies mode, then model, then options, and a rejected
  model stays visible as an agent warning. Nothing is applied mid-turn and no
  second execution path exists.
- `normalizeFastModeSelectors` treats Devin's `speed` select as its per-model Fast
  control, so a model declared without Fast neither shows nor dispatches a
  `speed` value borrowed from another model.

## Alternatives

- Independent Lead and Sidekick controls: unavailable in ACP 3000.12.28; Devin
  would have to advertise them.
- Composing `fusion-*` ids from labels: rejected; the runtime rejects unadvertised
  values, and the UI would misreport what runs.
- Reading Devin's catalog cache in Lody or adding a `_meta.lody.fusion`
  declaration: not needed while the advertised values and names carry the pairs,
  and either needs maintainer agreement as a new private or protocol dependency.
- Two ordinary agents imitating Fusion: rejected; it is not Devin's orchestrator.

## Consequences and limits

- Only builtin Devin with parseable Fusion values gets the entry, on the session
  composer and chat landing. Mobile, schedules and draft child tabs keep the list.
- A changed naming shape degrades to the flat list; no pair is invented.
- A pair with neither recorded options nor a declaration keeps Devin's defaults
  until the agent's capabilities are refreshed.
- No price is shown, because Devin reports no verified pricing over ACP.
- Unverified: the content of a real Fusion turn (the quota probe stopped at
  admission), and the desktop app against a live runtime.

## Verification

- `packages/components/tests/fusion-builder.test.tsx`: catalog parsing, labels,
  unadvertised pairs, controls, pair changes, apply edits, runtime confirmation,
  dialog rendering and menu gating.
- `packages/components/tests/acp-selector-options.test.ts`: Devin `speed` follows
  the declared Fast support.
- `packages/components/src/stories/FusionBuilderDialog.stories.tsx`: dialog states.

Related: [per-model capability rows](../architecture/2026-09-29-per-model-acp-capability-row.md)
and [observed per-model options](../../proposed/architecture/2026-11-11-observed-model-config-options.md).
