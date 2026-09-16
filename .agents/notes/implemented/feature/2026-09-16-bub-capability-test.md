# Explicit Bub capability testing and installation recovery

Status: implemented
Translation: current

[中文](2026-09-16-bub-capability-test.zh.md)

PR: [#743](https://github.com/LodyAI/Lody/pull/743)

## Abstract

Bub creation hid the capability-test action, making installation problems visible
only after leaving the dialog. The dialog now exposes Test and follows the durable
setup task until verification succeeds, then offers Refresh for the published
provider. Missing-runtime failures reuse the existing installation and retry UI;
refresh failures also offer installation help. Test can add the provider after
successful verification, and closing the dialog does not cancel durable setup.

## Decision

This changes the creation-time UI choice in the
[original Bub integration](2026-09-11-builtin-bub-provider.md), preserving its
success-only publication and user-managed runtime contracts. Behavior is specified
in the [draft Spec](../../../../specs/bub-provider-verification.md).

Simply unhiding the generic probe would both enqueue setup and start a second ACP
refresh. Instead, creation observes the same setup and published-config atoms
used by the provider list. Pending setup fixes the configuration and provider type;
its retry/delete actions use the existing durable commands. After publication,
Refresh and Save persist the same config without enqueueing another setup.

The installation command and link now have one shared presentational component.
Setup retains the daemon's distinction between missing runtime and other failures;
existing-provider refresh errors keep their original diagnostic alongside the guide.

## Verification

The owning dialog suite exercises setup failure, installation guidance, durable
retry, publication, and subsequent refresh; it also covers refresh-error recovery
for an existing Bub provider and the legacy-daemon gate. Provider setup row/writer
suites cover copying/opening guidance and durable cancellation. A Storybook state
shows Bub installation recovery. Real Bub process execution is not covered by
these UI tests.
