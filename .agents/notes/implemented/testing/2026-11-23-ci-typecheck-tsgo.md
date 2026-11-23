# Typecheck with tsgo everywhere; components stays checked by each consumer

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/3226

English | [中文](2026-11-23-ci-typecheck-tsgo.zh.md)

## Abstract

`Static checks` spent 150–220 s in typecheck, and the last package to finish was
`apps/mobile-capacitor`, the only program still checked by single-threaded `tsc`.
Its program, like `apps/electron`'s renderer program, reaches all of
`packages/components` through source path aliases, so the 480k-line components
source is checked three times. Mobile and the `e2e` suite now use `tsgo`, which
checks the same mobile program with the same result in 13 s instead of 94 s.
Replacing the repeated source checks with components declarations was measured
and rejected: it saves about 30 CPU seconds per consumer, needs emit fixes, and
drops checks that only a consumer's own compiler options and path overrides make.

## Evidence

CI run `45154663628` (4-vCPU runner): every other package finished by 10:19:57;
mobile-capacitor's `tsc` ran until 10:20:58, about 150 s on its own.

Local measurements, 2026-11-23, Linux arm64, 16 cores, tsgo 7.0.0-dev.20251217.1,
each program run alone:

| Program | Files | Wall | CPU | Memory |
| --- | --- | --- | --- | --- |
| `packages/components` | 6953 | 14.4 s | 74 s | 4.6 GB |
| `apps/electron` `tsconfig.web.json` | 6341 | 12.9 s | 68 s | 4.3 GB |
| `apps/mobile-capacitor` `tsconfig.app.json`, tsgo | 6450 | 12.7 s | 68 s | 4.3 GB |
| `apps/mobile-capacitor` `tsconfig.app.json`, `tsc` | 6445 | 94 s | 117 s | 3.5 GB |
| All 14 tsgo programs | — | 66 s | 347 s | — |

The whole root typecheck under `taskset -c 0-3` (four cores) took 84 s with
`--workspace-concurrency=4` and 80 s with 2.

## Decision

Every Lody-owned typecheck script runs `tsgo --noEmit`, resolved from the root
`@typescript/native-preview` dev dependency as the other packages already do.
ACP adapter submodules keep their own `tsc` builds; they emit artifacts and are
maintained independently. Workspace concurrency stays at 4.

## Rejected alternatives

- **Consumers check components declarations instead of its source.** Emitting
  declarations for components takes 20 s and reports 13 errors: inferred types
  that cannot be named in stories, `src/ui/drawer.tsx`, and electron main modules
  that components imports. A prototype mobile program pointed at those
  declarations dropped from 68 to 37 CPU seconds but reported 207 errors, from
  types the failed emits degraded and from modules still resolved to source.
  The gain is about 15 s of wall time on a 4-vCPU runner. The cost is a build
  order (consumers wait for the emit) and lost coverage: mobile's
  `@/components/settings/account-setting` override and each consumer's stricter
  options (`noUnusedLocals`, lib and JSX settings) are checked against
  components call sites only because the consumer checks that source. Revisit
  only if components stops importing electron main modules and the consumers no
  longer override components modules.
- **Lower typecheck workspace concurrency.** 80 s against 84 s on four cores is
  within noise, and lower concurrency slows multi-core developer machines.

## Verification

- With tsgo, the mobile app and e2ee programs and the e2e program report no
  errors. An injected type error in each program is reported. The e2e program
  lists the same 81 files under tsgo and `tsc`.
- The CI wall-time effect is unmeasured until the change runs on a PR.
