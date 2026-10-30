# Session continuation controls without a beta gate

Date: 2026-10-30
Status: implemented
Translation: current

[中文](2026-10-30-session-continuation-general-availability.zh.md)

## Abstract

Automation was available to Agents through MCP while its Session controls required a separate developer beta opt-in. Supported local Sessions now show their existing continuation notes and settings without that UI gate. Automatic recovery remains a per-Session opt-in, and unsupported remote UI and encrypted workspaces do not gain a control channel.

## Boundary

Electron reads and manages only the current machine's automation owner and consults the shared workspace content capability before making requests. The Agent's MCP server and the Host retain their existing ownership and authorization rules. Removing the old renderer-only preference does not enable any Session policy or migrate persisted automation. Remote Agents can use their own machine's local MCP and daemon; cross-device UI control and encrypted automation require their own transport and authority work.

The component tests exercise normal-mode waiting, settings and cancellation, and absence of owner requests without a supported local target. CLI and component typechecks and the relevant suites are reported with the change; cross-device and encrypted delivery remain untested and unsupported.
