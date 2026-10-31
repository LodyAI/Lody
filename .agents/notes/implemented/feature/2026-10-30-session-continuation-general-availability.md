# Session continuation controls without a beta gate

Date: 2026-10-30
Status: implemented
Translation: current

[中文](2026-10-30-session-continuation-general-availability.zh.md)

## Abstract

Automation was available to Agents through MCP while its Session controls required a separate developer beta opt-in. Supported Sessions show their continuation notes and settings without that UI gate. Automatic recovery remains a per-Session opt-in; encrypted workspaces remain unsupported.

## Boundary

Electron manages local and eligible remote machine automation owners and consults the shared workspace content capability before making requests. The Agent's MCP server and the Host retain their existing ownership and authorization rules. Removing the old renderer-only preference does not enable any Session policy or migrate persisted automation. Remote control uses the [remote control design](../../proposed/architecture/2026-10-30-remote-session-automation-control.md); encrypted automation remains unsupported.

The component tests exercise normal-mode waiting, settings and cancellation. Live cross-device and encrypted delivery remain unverified.
