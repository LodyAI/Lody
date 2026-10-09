# Builtin Devin

Status: draft
Translation: current

[中文](builtin-devin.zh.md)

A user selects Devin in Add Agent or onboarding. The target machine prepares a
checksummed official Devin runtime from the public managed-runtime channel, then
launches the bundled ACP adapter with an explicit runtime path. Runtime downloads,
cache reuse, cancellation and background updates follow the existing managed-runtime contract.

The adapter is a pinned public submodule. Official runtime bytes are unmodified;
versioned manifests pin all six macOS, Linux and Windows arm64/x64 archives.
Publication requires official source checksum verification and complete canonical
channel upload/readback. Custom mirrors and dry runs never change production pins.

Authentication uses Devin's advertised ACP browser method and the existing
machine protocol capability gate. Credentials remain provider-owned. Models,
permissions and extension capabilities come from a live probe; no speculative
static model catalog or title ownership is added.

Devin, Dimcode, Kimi and Kimi Code are absent from registry discovery. Their
existing registry configurations remain launchable without automatic conversion
of provider records or native session IDs. Builtin brand icons remain available.

## Evidence

- `apps/cli/src/agent/setting.ts` and `managed-agent-runtime.ts`.
- `scripts/generate-acp-registry.mjs`.
- Official versioned manifest: <https://static.devin.ai/cli/3000.11.3/manifest.json>.
