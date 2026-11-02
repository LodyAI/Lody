# Sorbet ACP authentication

Status: proposed
Translation: current

[中文](2026-11-02-sorbet-acp-authentication.zh.md)

## Abstract

Builtin Sorbet needs agent-driven authentication and explicit credential form negotiation. It uses the existing ACP authentication lifecycle, which advertises credential form version 1 and carries form replies through the existing protected Machine RPC path. This retains the existing field and authentication-method limits; real Sorbet authentication remains unverified.

## Decision and evidence

Like [builtin Devin](2026-09-30-builtin-devin.md), Sorbet uses the agent's advertised authentication methods rather than a provider-specific login command. Remote input is encrypted to the target machine and bound to the request and interaction; secret defaults are excluded from retained form progress. The behavior test exercises negotiation, form replies and rejection of a stale interaction, but does not prove the behavior of a real Sorbet binary or its credential storage. Authentication supports text, secret and single-select fields, not arbitrary forms or terminal methods.

The change does not migrate the existing Promise-based authentication lifecycle to Effect: its launch, connection and shutdown dependencies are not a self-contained native unit.
