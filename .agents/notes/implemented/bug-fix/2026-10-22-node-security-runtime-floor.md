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
remain. Electron is evaluated separately from the standalone Node floors. The
2026-10-30 update pins Electron 44.10.0, whose embedded Node is 24.22.1.
That pin is the desktop runtime remediation for the October Node fixes. It
does not claim that installed apps or production releases have been replaced.

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
Manifests guide package managers but do not replace executable checks. The October 22 decision changes no package versions or artifact pins.

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
also lists Node 24.22.0 and introduces breaking changes. The October 22 decision
therefore did not treat either release as the TLS remediation.

## Update 2026-10-30

Electron [44.10.0](https://github.com/electron/electron/releases/tag/v44.10.0) is
the newest stable 44.x release and the first 44.x release whose notes update
Node to 24.22.1. Node's October security release fixes CVE-2026-111497 in the
bundled Brotli decoder and the numeric-hostname TLS checks CVE-2026-105483,
CVE-2026-106069, and CVE-2026-106072. `apps/electron` now depends on Electron
44.10.0. The same major stays in place; Electron 45 is a separate line.

An offline `tls.checkServerIdentity` probe with synthetic SANs is the hostname
evidence: 44.9.3 accepts five non-canonical aliases, and 44.10.0 rejects the
ten-case set, including valid DNS and IP controls. That probe is not a TLS
handshake, product login, or network exploit. Brotli evidence is the upstream
fix plus the embedded runtime's real `node:zlib` decoder, not a reproduced
Lody RCE. `process.versions.brotli` can stay 1.2.0 on the fixed runtime.
System Node and npm `undici` do not replace Electron's embedded decoder.
A valid Brotli buffer also decodes on 44.9.3, so that call does not by itself
show the out-of-bounds fix. A local macOS arm64 package built by
`scripts/package-electron.mjs` with `--publish never` reports Electron 44.10.0
and embedded Node 24.22.1. afterPack checked the embedded CLI, native SQLite,
node-pty including its spawn-helper, and the synthetic E2EE storage probe.
`codesign --verify --deep --strict` passed for the local Developer ID signature.
Notarization did not run. The packaged app ignores the dev-only plaintext
auth-storage switch, so the desktop smoke used the unpacked OSS build, an
isolated profile, and `LODY_ELECTRON_PLAINTEXT_AUTH_STORAGE=1`. That smoke
passed the six P0 scenarios. Cloud login, the real OS keychain, Windows, and
Linux were not accepted. Production deployment remains a separate
owner-controlled operation.

## Verification limits

Focused behavioral tests exercise each supported floor, vulnerable neighboring
versions, excluded lines, prereleases, preinstall rejection, and Electron/native
capability separation. CI configuration names repaired Node releases explicitly.
The npm dependency audit supplements this work: it does not audit Node/Electron
binaries and a runtime-floor change cannot resolve unrelated dependency advisories.
Local verification and package builds do not prove installed user apps or running
production images have been replaced.
