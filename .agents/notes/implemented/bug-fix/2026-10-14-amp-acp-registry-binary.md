# Launch Amp from the registry's versioned binary

Status: implemented
Translation: current

[中文](2026-10-14-amp-acp-registry-binary.zh.md)

## Abstract

Lody launched the registry Amp Provider through a local override, `npx -y amp-acp`,
with no version, while every npx launch adds `--prefer-offline`. npm then reuses the
first cached install indefinitely, so users stayed on an old adapter while the
catalog showed the registry's current version. The override is removed and Amp uses
the ACP Registry's binary distribution, which the ACP binary manager caches per
version, matching Zed. The trade-offs: users now need their own installed Amp CLI,
which npx used to bundle; the registry publishes no Windows ARM64 build; and Lody
does not verify the registry's archive checksums.

## Problem

`scripts/generate-acp-registry.mjs` replaced the registry's `amp-acp` distribution
with a local `npx` command. `--prefer-offline` is safe only for exact-version specs
(the comment on `NPX_CACHE_MODE_ARG` already assumed that). npm resolves a bare
package name from the cached packument under `--prefer-offline`; a reproduction
against a local registry stub stayed on 0.9.0 after 0.10.0 was published, and only
`--prefer-online` moved to 0.10.0. Adapter 0.8–0.10 added Amp model selection,
session resume with history replay, and durable thread lifecycle, so the stale
cache hid user-visible behavior.

## Decision

- Drop the `amp-acp` local override. The generator now keeps the registry's
  `binary` distribution, launched by `AcpBinaryManager` from
  `acp-bin/amp-acp/<version>/<platform-arch>`; a registry version bump is a new
  cache directory, so a Lody release with a regenerated registry upgrades users.
- With no local `npx` launcher left, `resolveRegistryAgentACPSetting` no longer adds
  the cache flag to local commands. A test asserts that no registry agent uses a local
  `npx` command and that every registry npx launch names an exact version.
- The generated file was edited only for the `amp-acp` entry, in the generator's
  output format, to avoid also bumping every other Provider.

Pinning `amp-acp@<version>` in the npx override was the smaller alternative. It
was rejected because it still needs Node.js, and manual bumps would drift from the
registry.

## Limits

- The binary is only the adapter: it runs `amp` (or `AMP_CLI_PATH`) from PATH. The
  npx install happened to bring `@ampcode/cli` and put its `amp` on the adapter's
  PATH, so a user with only `AMP_API_KEY` and no installed Amp CLI worked before and
  now fails on the first prompt (`Executable not found in $PATH: "amp"`). Provider
  verification does not catch it: it stops at `session/new`, which succeeds without
  `amp`. This is accepted because the adapter documents the installed Amp CLI as a
  prerequisite, Zed's registry install has the same requirement, and the official
  installer links `amp` into `~/.local/bin`, which Lody already adds to ACP PATH.
- The registry has no `windows-aarch64` build; on Windows ARM64, Amp now fails with
  the binary manager's unsupported-platform error instead of running through npx.
- The registry's per-archive `sha256` is dropped by `normalizeBinaryEntry`; downloads
  are trusted over HTTPS only, the same as other binary agents.
- Verified in an orb on linux-x86_64: the launch resolved to the 0.10.0 binary and
  ACP `initialize` returned `amp-acp` 0.10.0 with `loadSession` and resume. macOS
  and Windows launches were not exercised. An existing Amp Provider switches launch
  method on its next start; its capability cache key (`amp-acp@0.10.0`) is unchanged.
