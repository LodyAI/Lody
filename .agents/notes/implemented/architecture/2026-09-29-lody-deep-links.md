# Unified Lody session deep links

Status: implemented
Translation: current

[中文](2026-09-29-lody-deep-links.zh.md)

## Abstract

Session mentions emitted a generic session scheme that could open another application outside Lody. New mentions and session-copy actions now use one lody resource scheme across Stable, Nightly and OSS, with workspace identity preserved through parsing and navigation. In-app references stay within their source installation; external clicks follow the user's default, and startup does not reclaim it. Login callbacks remain installation-specific, with a new Stable callback alias; packaged OS dispatch and hosted callback deployment remain release-verification limits.

## Decision and responsibilities

The [deep-link Spec](../../../../specs/deep-links.md) describes the contract and rollout. This partially replaces the new-output format from the [session mention URI decision](../../implemented/feature/2026-09-18-session-mention-uri-and-paste.md), preserving legacy reading, plain-text paste and historical content. The initial proposal used different resource schemes by channel; the accepted direction instead uses one common resource scheme with explicit installation handoff only when needed.

Shared owns the pure builder/parser, export normalizer and MCP workspace-boundary helper. UI owns mention generation, copy, paste and workspace resolution; existing Session navigation handles exact child identities and tab reopening. Both UI and CLI Markdown exports normalize legacy prose references without rewriting history or tool payloads; anonymous exports do not invent workspace identity. Workspace IDs, not mutable or nullable handles, are authoritative; readable handles belong in labels. Electron owns resource intake and product-window forwarding, while About offers explicit default selection. Public embedded browsers and anonymous shares gain no workspace access.

The main receiver previously had no session resource route. Protocol replacement alone would not work: product navigation/external IPC allowed HTTP(S), and Markdown had a separate legacy-only button renderer. All those entry points now recognize shared session resources. Preload already buffers events until the router subscribes; renderer state additionally waits for workspace readiness. Explicit tab encoding avoids the route's last-active-tab restoration.

Stable used the same lody scheme for login callbacks. Once OSS or Nightly becomes the common default, retaining that address for new Stable attempts would deliver authentication to the wrong installation. New Stable attempts therefore request the stable browser channel and return to ai.lody.stable; unspecified legacy browser callers retain lody. The packaging hook adds resource/callback declarations for its resolved channel configuration. The browser callback page and any packaging flow that overrides this hook need coordinated release.

Registering the generic session OS handler was rejected because it competes with unrelated apps. HTTPS-only URLs cannot represent local-only sessions as public pages. Separate per-version resource schemes would force ordinary links to pick an installation; the common scheme instead accepts that external clicks use the user's default. Explicit workspace mismatch never silently searches another data space.

## Review corrections

The shared scheme remains available to every channel. Legacy common cloud routes now hand off only to Stable's private alias, with a visible redacted failure if unavailable; chat/new stays local. This compatibility handoff is separate from explicit user-directed session workspace handoff. Windows startup fills an absent common handler but preserves existing defaults; it does not establish installer registration before first launch. The channel catalog is shared by runtime parsing, IPC and packaging.

Batch status isolates invalid references; compound paste mentions the child. Partial text export skips absent strings, normalizes punctuation/emphasis-wrapped legacy links and bypasses Markdown parsing for unrelated schemes. Pending session restoration waits for child synchronization, expires after 15 seconds and cancels on departure or superseding navigation.

Review baseline: the stale local main has no merge base in this shallow checkout. The PR branch includes main commit `7700f420`; the verified feature diff uses origin/main's merge base at that commit, not the unrelated local main.

## Verification and limits

Review fixes passed 97 focused cases (59 shared, 13 navigation/paste, 15 MCP, 10 desktop) and all 48 repository script tests. Workspace typecheck, lint, formatting, localization and boundary checks passed. Full CI testing stopped at a React `act` error under the inherited production environment; it is not a complete-suite pass. Documentation checks retain six pre-existing missing Kimi/Pi submodule links. Windows tests inject registration state; clean Windows installation remains unverified.

Behavioral coverage exercises parser round trips and hostile inputs, MCP workspace rejection, mention output, new/legacy Markdown clicks and anonymous inert rendering, paste/workspace resolution, version callback parsing, packaging declarations, and AppImage default preservation versus explicit selection. The desktop protocol tests execute real modules with injected OS adapters and inspect resulting registration state and desktop files, not source text.

Export normalization uses Markdown syntax positions to protect code (including nested fences), HTML and images, replacing only recognized prose URIs without reserializing the document. Its parser dependency is separate from the lightweight resource parser used by Electron intake. Tests cover source-history immutability, explicit foreign workspace preservation and both export builders.

The public source has no private channel build roots. Packaging configurations that reuse the shared beforePack hook receive the new protocol declarations; independent channel hooks must adopt the same contract. No installer, real OS handler, production browser authorization or remote deployment was exercised. Historical stored text and edit-and-resend are unchanged; MCP root+tab references require a direct child ID instead. Existing OS window selection remains main-window based. [PR #1151](https://github.com/LodyAI/Lody/pull/1151) tracks this work; no human Spec approval is claimed; executed command outcomes are reported in the task handoff.
