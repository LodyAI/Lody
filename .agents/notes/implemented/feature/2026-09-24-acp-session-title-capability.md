# Negotiate Provider-owned session titles

Status: implemented
Translation: current

[中文](2026-09-24-acp-session-title-capability.zh.md)

## Abstract

Title ownership previously depended on a builtin identity table, leaving custom
Providers unable to prevent a duplicate title process. Core now exposes the
versioned sessionTitle capability, and Lody decides from the main Session's live
initialization before starting its fallback generator. Tagged generated titles
reach the existing sanitized write that preserves user names. Legacy builtin
behavior remains; Provider generation failure leaves the draft title.

This partially replaces the identity-only decision in the
[earlier note](../architecture/2026-09-08-acp-owned-session-titles.md).
The [draft contract](../../../../specs/acp-session-titles.md) defines current intent.
A new RPC was unnecessary because ACP already carries title update callbacks.
Moving the decision after initialization avoids relying on a stale or absent
cache. Cache v9 carries the support bit through probes, Session startup, Flock
comparison and settings; older understood fields remain readable. Explicit
fallback tags override legacy untagged trust. Claude, Codex and Grok now advertise the capability in their adapter sources.
Claude distinguishes generated output, persisted custom names and fallback summaries;
source changes bypass text deduplication. Codex retains explicit native name events.
Grok tags unmarked official runtime names as explicit while preserving existing tags.
The Grok wire cannot distinguish unmarked fallback text from a real name, so this
preserves its earlier trust boundary rather than proving generated provenance.
Adapter release versions and managed-runtime pins are not changed; older installed
runtimes retain the compatibility path until the source changes are released.

Validation covers capability parsing/version rejection, native and legacy title
routing, main Session startup with/without support, cache changes, and settings.
Adapter checks passed: Claude title/agent tests (10 existing skips), Codex
initialize/event tests, Grok proxy/runtime tests, Claude build/lint, Codex typecheck,
and Grok syntax build. The run-codex skill's minimal live prompt completed with
end_turn; this verifies startup/turn flow, not the asynchronous generated-title
notification. No live Claude/Grok title generation was invoked.

Full `pnpm check`, `pnpm format`, and documentation checks passed before submission.

Core 0.1.7 is now published. Claude, Codex and Grok pin that release; the two npm lockfiles record its registry integrity. Lody pins the Core release commit and retains its workspace override. The published package source matches that checkout.

## Companion PRs

- [Core #13](https://github.com/LodyAI/acp-extension-core/pull/13)
- [Claude #33](https://github.com/LodyAI/acp-extension-claude/pull/33)
- [Codex #53](https://github.com/LodyAI/acp-extension-codex/pull/53)
- [Grok #19](https://github.com/LodyAI/acp-extension-grok/pull/19)
- [Kimi #15](https://github.com/LodyAI/acp-extension-kimi/pull/15)
- [DSH #23](https://github.com/LodyAI/acp-extension-dsh/pull/23)

Kimi and DSH now opt in through the same capability. Kimi checks the native managed
OAuth provider configuration and requests generation after an accepted prompt launch.
API-key-only configurations retain client generation. Its metadata projection
preserves generated/custom/replaceable provenance. DSH retains the upstream base
bundle's first-prompt LLM plugin and forwards durable session/title events through
the ordered session output queue. Native user-name protection remains authoritative.
Pi 0.87.0 exposes naming APIs but no built-in automatic title generator, so it stays
on the existing client path. Runtime release versions are unchanged.

Validation: Kimi ACP's 188 tests, typecheck and build passed in a standalone
checkout on Node 24.15; scoped lint reports only existing warnings. DSH's 36 tests,
build and formatting check passed. The published base bundle confirms its
session-title-llm row is the first-prompt LLM provider. No live title service or
model request was made. [DSH PR #23](https://github.com/LodyAI/acp-extension-dsh/pull/23).
