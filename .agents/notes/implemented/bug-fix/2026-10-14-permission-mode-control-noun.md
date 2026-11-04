# Name the composer control what it resolves to, and share rows by what the switch does

Status: implemented
Translation: current

[中文](2026-10-14-permission-mode-control-noun.zh.md)

## Abstract

Two adjacent labels described Lody's internal abstraction instead of what the
control is or does. The composer permission button called every resolved control
"Permission", so a Grok-style mode list showed "Permission: Agent" over
Agent/Plan/Ask; and on Settings > Machines the folder share row placed the state
word "Private" next to an off switch, reading as "Private: off" beside the
machine's action-labelled "Share machine". The shared face resolver now reports
whether the control is a genuine `_permission` option or a mode selector, so all
surfaces name it "Mode" (or the provider's own label); editable share rows now
carry a constant action label matching the machine row. Verification is limited
by this nested checkout's stale dependencies; the owning vitest suites could not
run here.

## Problem and evidence

User feedback on the shipped UI raised two label-grammar complaints:

- **"Permission: Agent" tooltip.** `DesktopPermissionModeButton` hardcoded the
  `chat.runConfig.permissionLabel` noun into `aria-label`/`title`
  (`desktop-run-config-menu.tsx`). `resolvePermissionModeFace`
  (`lib/permission-mode-face.ts`) intentionally resolves one control from three
  sources — an explicit `_permission`/`permission_mode` config option, legacy
  ACP `modeOptions`, or a `category: 'mode'` selector standing in — but only the
  first is a permission knob. Registry/custom agents that expose session modes
  such as Agent/Plan/Ask reach the button through the mode sources, so the noun
  was wrong. Grok's own `interaction_mode` selector never reaches this control
  (it renders as a separate run-config row), and builtin Grok exposes a real
  `permission_mode`, so the mislabel targets non-builtin or probed agents.
- **Machines toggle grammar.** `machine-detail-pane.tsx` labels its switch
  "Share machine" (action), while `my-machine-connected-resources.tsx` printed
  the state word "Shared"/"Private" beside a switch whose checked state is also
  `sharedWithTeam`. Polarity was already identical; the mismatch was that one
  label names the action and the other names the current state, so "Private" +
  off reads ambiguously.

## Fix

- `PermissionModeFace` gains `semantics: 'permission' | 'mode'`
  (`Boolean(explicitPermissionSelector)`) and `selectorLabel` (the config
  selector's own name). `source.kind === 'configOption'` alone could not
  distinguish a real permission selector from a mode stand-in, so the resolver
  now returns the discriminator it already computes.
- `permissionModeControlLabel(face, t)` is the one noun rule: `Permission` for
  permission semantics, else the provider `selectorLabel` or `Mode` via the new
  `chat.runConfig.modeLabel` key (en "Mode" / zh "模式").
- Consumers: the desktop button's aria-label/title, the mobile run-config sheet
  row label, the Agent Role detail pane row, and the story-only
  `AcpBottomBarModeSelector` aria/title. The mobile sheet's duplicated
  permission resolution was replaced by `resolvePermissionModeFace` outright —
  the lib's own contract is that these surfaces must not drift on which knob
  carries permission, and it had drifted into a fourth copy.
- Machines folder rows: the editable row shows a constant
  `workspace.projects.shareToggle` ("Share project with team", already
  translated and matching the mobile project-settings row) + switch; the
  `Shared`/`Private` state word remains only in the `readOnly` render where no
  control exists. The machine row was already action-labelled and is unchanged.

## Alternatives and trade-offs

- State grammar on both rows ("Private"/"Shared" + switch on the machine row
  too) was rejected: it keeps the same "state word next to off switch"
  ambiguity symmetrically and drops the machine row's clearer action affordance.
- A segmented `Private | Shared` control in both places removes switch
  ambiguity entirely but abandons the `Switch` primitive and widens the row;
  kept as the fallback if action labels still read unclear.
- Using `selectorLabel` as the noun for permission semantics too ("Permission
  Mode: Always Approve") was rejected to keep the established short noun.

## Verification

`pnpm lint:i18n` passes with the new key. `pnpm format` applied. The touched
test file was extended: mode sources now assert "Mode: Agent" (previously
"Permission: Agent"), plus new cases locking "Permission" to an explicit
`_permission` selector and naming a mode-category stand-in after its provider
label.

Verification limits: this nested checkout's workspace dependencies predate the
Effect v4 migration (`packages/shared` still links `effect@3.18.4`), so vitest
suites cannot run here — every test file importing `@lody/shared` fails at
`Context.Service`. A scoped `pnpm install` is also blocked: the
`acp-extension-devin` submodule is not checked out, and `--no-frozen-lockfile`
trips the repository's `minimumReleaseAge` floor on newer lockfile pins, which
must not be weakened. `pnpm --filter @lody/components typecheck` fails only in
`../shared` stale-dependency files; no errors in the touched files. `pnpm run
docs check` reports pre-existing broken links into unchecked-out submodule
paths, unrelated to this change. Behavior therefore rests on code review plus
the updated test source; run the owning suites in a standalone checkout before
merge.
