# Sorbet ACP authentication

Status: proposed
Translation: current

[中文](2026-11-02-sorbet-acp-authentication.zh.md)

## Abstract

Builtin Sorbet needs agent-driven authentication and explicit credential form negotiation. It uses the existing ACP authentication lifecycle, which advertises credential form version 1 and carries form replies through the existing protected Machine RPC path. This retains the existing field and authentication-method limits; real Sorbet authentication remains unverified.

## Decision and evidence

Like [builtin Devin](2026-09-30-builtin-devin.md), Sorbet uses the agent's advertised authentication methods rather than a provider-specific login command. Remote input is encrypted to the target machine and bound to the request and interaction; secret defaults are excluded from retained form progress. The behavior test exercises negotiation, form replies and rejection of a stale interaction, but does not prove the behavior of a real Sorbet binary or its credential storage. Authentication supports text, secret and single-select fields, not arbitrary forms or terminal methods.

Sorbet's own `sorbet.dev` credentials v1 extension lists saved provider IDs and credential types and removes one provider. It does not establish account identity, validity, or environment-provided credentials. Lody invokes it through a bounded process on the target machine rather than reading credential files or treating it as a Lody ACP extension. Remote list and logout require `sorbetCredentialsRemote` and signed E2EE owned execution; the target checks that the signer belongs to its owner membership. Both operations use the execution journal because listing starts a process, and interrupted logout can have an unknown outcome. The daemon serializes its Sorbet authentication and credential mutations; a local socket disconnect cancels the child, and unconfirmed process cleanup blocks later mutations until recovery. This ownership is daemon-local and cannot coordinate independently launched Sorbet processes. The [real-process test](../../../../apps/cli/src/agent/sorbet-acp-credentials.real-process.test.ts) exercises synthetic credentials; real OAuth remains unverified.

Sorbet tracks the `alpha` npm tag so runtime fixes can ship independently of Lody. Unlike exact registry packages, a tag cannot safely use `--prefer-offline` as its primary mode: npm may retain stale metadata indefinitely ([Amp evidence](../../implemented/bug-fix/2026-10-14-amp-acp-registry-binary.md)). Network failure can fall back to an existing cached install only after safe startup cleanup; cold offline startup still fails. The floating tag does not identify a capability version, so explicit refresh probes again.

The change does not migrate the existing Promise-based authentication lifecycle to Effect: its launch, connection and shutdown dependencies are not a self-contained native unit.
