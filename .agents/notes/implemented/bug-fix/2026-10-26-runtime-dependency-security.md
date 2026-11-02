# Patch Electron, undici and Storybook security boundaries

Status: implemented
Translation: current

[中文](2026-10-26-runtime-dependency-security.zh.md)

## Abstract

Electron's missing compromised-certificate block, npm undici's orphaned response
stream, and Storybook's exposed development server require separate repairs.
Pin Electron 44.9.3, raise undici's 6.x floor to 6.29.1, and apply vulnerability-range
overrides to patch each undici major independently. Both Storybook workspaces use
10.6.2 and default to loopback. This source change does not replace deployed apps
or resolve Electron's separate numeric-hostname TLS weakness.

## Decision and boundaries

- [Electron advisory](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9):
  44.9.1 adds the eMudhra block to Chromium and Node TLS clients; use the existing
  44.x line's 44.9.3 stable patch and retain the exact release-age exception.
- [undici advisory](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c):
  explicit npm imports in CLI HTTP and preview transports remain independent of
  system Node's bundled fetch. Patch 6.x/7.x/8.x to 6.29.1/7.30.1/8.12.2; do not
  force tools onto a different API or runtime major.
- [Storybook advisory](https://github.com/storybookjs/storybook/security/advisories/GHSA-px85-f4q5-jh77):
  coordinate core, React and Vite integrations in components and review-helper.
  Default development listeners to 127.0.0.1. Static output is a separate boundary.

## Reproduction and verification limits

`node --test scripts/security-undici-probe.test.mjs` observes the natural exit of
an isolated client after a caught rejection, plus a valid-response control. Run
`node scripts/security-undici-probe.mjs <resolved-undici-module>` to compare an
older installation, without hardcoded runtime or dependency paths. The server is
synthetic and loopback-only; the client installs no uncaught-error handler and
never forces a successful exit. The timeout bounds hangs; it does not sequence
response delivery. On the same Node 22.23.4, 6.26.0 catches fetch then exits 1 with
`UND_ERR_RES_CONTENT_LENGTH_MISMATCH`; 6.29.1 catches and exits 0.

Electron 44.9.3 reports Node 24.22.0, Node-API 10 and Chromium 152.0.7977.167.
Its offline `tls.checkServerIdentity` still accepts fullwidth/dotted/numeric
aliases with `DNS:127.0.0.1`. Preserve the separate
[hostname TLS follow-up](2026-10-22-node-security-runtime-floor.md); the eMudhra
upgrade must not close it. A version floor and synthetic transport tests cannot
prove rejection of an actual compromised certificate or hosted sign-in success.
Foreign-platform, signed/notarized installer, and production delivery evidence
remain separate from local macOS arm64 builds and smoke checks. The PR records
commands and observed checks for its exact head.

The initial Session smoke stalled in native `SecItemCopyMatching` /
`SecKeychainItemCopyContent`, established by a main-thread sample. The same built
app passed with an older Electron binary. Enabling the existing dev-only plaintext
auth-storage switch in the harness's disposable profile made 44.9.3 pass the same
Session scenario. Keep that automation setting inside the unpackaged test launch;
`app.isPackaged` still rejects it. This control resolves the observed automation
blocker, not a demonstrated sync defect, and deliberately does not validate native
Keychain access. No sync or product authentication code changes are required.
