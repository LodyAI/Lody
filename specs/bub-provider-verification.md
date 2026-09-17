# Bub provider verification

Status: draft
Translation: current

[中文](bub-provider-verification.zh.md)

When adding Bub, the user can explicitly test its ACP capabilities before leaving
the configuration dialog. Test starts durable provider setup on the selected
machine and shows its progress in the dialog. Successful verification adds the
provider and exposes Refresh; failure keeps it unpublished and retryable. Create
continues to start the same setup in the background.

While setup is pending, the submitted configuration is fixed. The user can retry
or delete the setup; deletion returns to the editable form. Closing the dialog
leaves the durable setup available in the provider list. Machines without the
provider-setup protocol cannot start this creation workflow.

Missing Bub or its ACP plugin shows installation instructions, a copyable install
command, and an installation-guide link. Lody does not install Bub automatically.
Existing providers can refresh capabilities; refresh errors retain diagnostics
and offer the same installation guide. A successful retry clears that guidance.

## Evidence

- [Dialog](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [Recovery row](../packages/components/src/components/settings/provider-setup-row.tsx)
- [Behavior tests](../packages/components/tests/agent-config-dialog.test.tsx)
- [Decision](../.agents/notes/implemented/feature/2026-09-16-bub-capability-test.md)
