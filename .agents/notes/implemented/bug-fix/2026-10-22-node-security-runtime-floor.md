# Enforce the October 2026 standalone Node security floors

Status: implemented
Translation: current

[中文](2026-10-22-node-security-runtime-floor.zh.md)

## Abstract

The workspace and CLI accepted Node runtimes predating the October 2026 security
release, despite downloading and unpacking remote artifacts and making HTTPS
requests. Standalone Node now requires 22.23.4+ within 22.x, 24.22.1+ within 24.x,
or 26.12.1+ within 26.x; installation and CLI startup enforce the same boundaries.
CI uses exact repaired versions, while SQLite's Node-API 10 and architecture checks
remain. Electron is evaluated separately: its Chromium Brotli already contains the
relevant decoder fix, but its Node TLS hostname checks remain an unresolved release
qualification item; this change does not claim to remediate the packaged desktop.

## Decision

The [Node security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
identifies CVE-2026-111497 and CVE-2026-106069 for all three supported lines;
CVE-2026-105483 affects 24.x and 26.x. A single `>=22.23.4` constraint would still
accept vulnerable 24.x/26.x and end-of-life odd releases. Keep three bounded ranges
and reject unknown future lines and prereleases until separately qualified.
The root dependency-free preinstall and the first-import CLI guard enforce the
range before installation and CLI application initialization. The production
bundler can evaluate static external imports before the inlined entry guard, so
source import order is not a promise that every dependency module loads afterward.
Manifests guide package managers but do not replace executable checks. No package versions or artifact pins change.

Managed Node-package adapters inherit the CLI's `process.execPath`; the CLI gate
therefore covers standalone child launches without changing artifact manifests.
Electron's embedded CLI continues through the existing Node-API and architecture
guards, since Node version text alone cannot establish Electron backports.

## Electron evidence and follow-up

Electron 44.7.0 embeds Node 24.21.0 and Chromium 152.0.7977.130. Its
[Node GN patch](https://github.com/electron/electron/blob/v44.7.0/patches/node/build_add_gn_build_files.patch)
links Brotli to Chromium's `//third_party/brotli:dec`, rather than Node's vendored
Brotli. Chromium's [decoder source](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/third_party/brotli/dec/decode.c)
contains `BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH` and
`BROTLI_SAFE_WITH_STATUS`, corresponding to the [Node decoder fix](https://github.com/nodejs/node/commit/49dff6f57aa72cbbe13e480cd41ff4e46837c8fc).
This supports correction of a version-only Brotli finding for this Electron build;
it is source inspection, not a malicious-stream or exploit test.

An offline synthetic probe of the installed 44.7.0 binary's `tls.checkServerIdentity`
accepted fullwidth `１２７.0.0.1` with `DNS:127.0.0.1`; Node 22.23.4 rejected it,
and canonical `127.0.0.1` with an IP SAN passed in both. An independent probe
also found Electron accepting `127。0.0.1`, `127.1`, `0x7f000001`, and `2130706433`
with `DNS:127.0.0.1`; repaired Node 22.23.4 rejected all five non-canonical hosts,
even with a matching IP SAN. These probes demonstrate the fullwidth and numeric
hostname validation weaknesses relevant to CVE-2026-105483/CVE-2026-106069 without
proving an exploitable product URL or network path. Node HTTPS/TLS clients in the embedded CLI remain relevant; Chromium
renderer networking has a different certificate implementation.

Electron [44.9.3 release notes](https://github.com/electron/electron/releases/tag/v44.9.3)
only identify ANGLE/Chromium/PDFium/Skia/V8 backports; its
[DEPS](https://github.com/electron/electron/blob/v44.9.3/DEPS) still pins Node 24.22.0.
The Node patch list has no identified hostname-validation backport. Electron 45.0.0
also lists Node 24.22.0 and introduces breaking changes. Neither is established here
as a safe TLS remediation, so no speculative Electron upgrade is included.

Before closing the desktop finding, obtain an upstream release containing the
[105483](https://github.com/nodejs/node/commit/de49c913f232fd9c216bf164818c87c0cb645b7b)
and [106069](https://github.com/nodejs/node/commit/935918e3427911f2bef315638d68308dfecc61ba)
fixes or equivalent documented backports, inspect its actual sources, run upstream
hostname regression cases in the shipped binary, and validate embedded CLI/native
loading and packaged desktop startup on each supported target. Updating system
Node does not replace an already shipped Electron runtime. Production deployment
and installer delivery remain separate owner-controlled operations.

## Verification limits

Focused behavioral tests exercise each supported floor, vulnerable neighboring
versions, excluded lines, prereleases, preinstall rejection, and Electron/native
capability separation. CI configuration names repaired Node releases explicitly.
The npm dependency audit supplements this work: it does not audit Node/Electron
binaries and a runtime-floor change cannot resolve unrelated dependency advisories.
Local verification and package builds do not prove installed user apps or running
production images have been replaced.
