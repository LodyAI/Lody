# Sidebar Session agent icons

Status: implemented
Translation: current

[中文](2026-09-12-sidebar-session-agent-icons.zh.md)

## Abstract

Imported Sessions from different coding agents were indistinguishable in the sidebar when their titles were similar. Sidebar row models now retain the Session's ACP agent identity and every Workspace, Local Project, Updated, and Pinned row renders the existing agent icon immediately before its title. The icon is passive and does not compete with working, permission, or unread status at the trailing edge; older synthetic row models without agent metadata remain valid and simply omit it.

## Decision

Use the existing `AgentIcon` mapping instead of introducing sidebar-specific assets. Carry `cliType` and `agentType` through the pure sidebar view models so imported history and live Sessions follow the same rendering path.

The shared row primitive renders the icon in a fixed 12px slot before the title. Author avatars and pin state remain separate facts, while the existing trailing status priority stays unchanged.

## Alternatives

A hover-only label would keep the compact row unchanged, but it would not satisfy the bulk-import workflow: users need to scan Claude, Codex, and other Sessions without opening each menu. Replacing the trailing status icon was rejected because it would hide the agent precisely while a Session is active or needs permission.

## Verification

Focused component tests cover identity propagation and rendering in both grouped and Updated lists. Type checking and repository checks validate the remaining Local Project path, which consumes `SessionMeta` directly.

## Limits

The row model intentionally carries only the persisted ACP identity. Provider-brand overrides that exist solely in a current machine configuration continue to use the generic icon for that ACP agent when the configuration is unavailable to the sidebar model.
