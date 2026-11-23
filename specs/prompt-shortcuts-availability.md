# Prompt Shortcuts availability

Status: draft
Translation: current

[中文](prompt-shortcuts-availability.zh.md)

When a user opens workspace settings, Prompt Shortcuts is available without enabling Developer mode or a Beta switch. The composer can discover shortcuts whenever its workspace runtime and scope are ready, including through the command menu.

The old local Beta preference no longer affects availability. Desktop and mobile About settings no longer offer its switch. Workspace identity, readiness, platform capabilities, shortcut visibility and scope rules remain in force; promotion does not grant access to another user's shortcuts.

## Evidence

- Settings: `packages/components/src/components/settings/settings-tabs.tsx` and `prompt-shortcuts-setting.tsx`.
- Discovery: `packages/components/src/components/mentions/use-shortcut-mention-source.ts`.
- Runtime: `packages/components/src/providers/prompt-shortcut-provider.tsx`.
