# Developer controls can restart onboarding

Status: implemented
Translation: current

[中文](2026-10-14-developer-restart-onboarding.zh.md)

## Abstract

Desktop onboarding keeps its completion marker in Electron main and its resumable phase and draft in renderer storage, so changing only one store cannot reliably restart the flow. Developer mode in About now offers a restart action that clears renderer progress and the session flow ID, resets the main-process marker, restores native Light theme, and reloads the primary window at `/onboarding`. The action is restricted to the trusted primary-window IPC sender and leaves configured agents, projects, and workspaces intact. Automated behavior checks were not run for this change.

## Decision

The existing onboarding contract assigns durable completion to Electron main and resumable progress to the renderer. The new action follows that split: the renderer clears `desktopOnboardingPhaseAtom`, `desktopOnboardingDraftAtom`, and the session-scoped analytics flow ID, then a dedicated IPC method validates the primary main-frame sender, resets the durable completion marker, pins the native window to Light, and changes the renderer reload target to onboarding before reloading.

The button lives in desktop About's Developer mode controls because it is a local development convenience. It does not clear product setup such as Agent configurations, projects, or workspaces; those remain useful when exercising onboarding again. The reload target uses the standard product renderer so the flow is available even when the Devbar renderer is enabled.

## Verification limits

No tests or application checks were run. The implementation relies on the existing route, state atoms, and reload machinery; a manual desktop launch is still needed to verify the full visual flow.
