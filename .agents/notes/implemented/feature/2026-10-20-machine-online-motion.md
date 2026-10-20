# Breathing online machine indicator

Status: implemented
Translation: current

[中文](2026-10-20-machine-online-motion.zh.md)

PR: [#1742](https://github.com/LodyAI/Lody/pull/1742)

## Abstract

The user requested motion for the static green online mark on machine cards.
The outer halo now expands and contracts at a constant speed over 2.8 seconds
while the solid centre stays green. Offline machines remain static, and reduced
motion retains the original stationary halo. This changes presentation only; the
existing presence value still determines whether a machine is online.

## Decision

`WorkspaceMachineAccordionRow` owns the same mark in collapsed and expanded
cards. Its separate decorative halo animates only transform and opacity, keeping
the dot's layout box, accessible status label, and card interactions unchanged.
Linear timing gives uniform scaling in each direction, with 1.4 seconds to
expand and 1.4 seconds to contract. The halo unmounts when `isOnline` becomes
false. CSS handles the loop and the reduced-motion preference without a timer,
React updates per frame, or network requests. The centre stays fully visible so
motion never makes an online machine look disconnected.

The existing MachinesDesktopLayout stories gain a controlled presence preview
using the real collapsed card. It supports inspection of online/offline transitions
without requiring a real machine or transport.

## Verification

The existing accordion behavior test passes. Components type checking, targeted
typed lint, and formatting of the changed TypeScript files pass. A real browser
run of the OnlineStatusMotion story samples the halo at evenly spaced
deterministic animation times: equal time steps give equal scale changes in
each direction, while the centre colour, centre opacity and dot box remain
unchanged. It also
verifies online/offline/online transitions and that reduced motion removes the
animation and preserves a static halo. A two-cycle browser recording provides
the visual preview.

The full `pnpm check` passes, including workspace type checking, typed and
Effect lint, all configured workspace tests, i18n validation, and boundary
guards. `pnpm format` also passes. The documentation check retains six existing
missing Kimi/Pi submodule links in the bilingual subagent-events note.

A cropped recording of the real card with synthetic machine data:

![Linear online halo animation](../../assets/machine-online-motion/linear.gif)
