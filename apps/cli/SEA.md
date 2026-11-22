# Cloud managed daemon publication

This repository owns the SEA builder, updater, and cloud-composed CLI bytes. npm publication remains JavaScript and retains its OIDC
workflow. `publish-daemon-sea.yml` is an independent publisher used by stable/next
releases and the admitted Nightly candidate. It pins Node 26.13.0 without changing
the desktop runtime pin. Nightly reuses the reserved desktop/mobile/CLI version
and admitted source SHA; it never allocates another counter.
Build jobs install only `lody...` from the root frozen
workspace. Backend Worker tooling is not part of the daemon and must not run its
platform-dependent postinstall scripts on the native Windows ARM64 builder.

The six native platform jobs stage the complete cloud CLI, sign owned native code,
build the SEA (with optional Windows Authenticode signing), probe its extracted
native modules, then generate SHA-256
manifests. Official Node bytes stay unchanged and cacheable. All platform jobs must
freeze their exact artifacts before publication. Retries restore same-run artifacts;
an earlier pre-freeze build failure may rebuild that platform. A missing artifact
after a successful freeze, expired/ambiguous artifacts, or unavailable attempt
history require the original bytes or a fresh version.
Historical npm recovery dispatch does not build new SEA bytes.

`sea-publish.mjs` verifies the entire platform matrix and final compressed/raw hashes
before uploading. Immutable version paths accept absent or byte-identical objects
only, with readback. Channel pointers move only after every immutable upload,
using conditional writes; a stale Nightly cannot move a pointer backwards. R2 serves
versioned files immutably and channel manifests with short revalidation.

Configure these GitHub Environment values before enabling publication:

- Existing macOS certificate and Apple notary secrets.
  `MACOS_CERTIFICATE_NAME` keeps the same certificate-name qualifier used by Electron.
  The SEA publisher resolves it against the imported P12 and signs native modules
  and the executable with the same unique Developer ID Application fingerprint.
- Windows signing is optional: omit both `WINDOWS_CERTIFICATE_P12_BASE64` and
  `WINDOWS_CERTIFICATE_PASSWORD` to build without additional Authenticode signing.
  To sign, supply the certificate and its password if needed (passwordless PFX is
  supported). A configured certificate must sign successfully; invalid or partial
  credentials never silently fall back to unsigned publication.
- `R2_ACCOUNT_ID`, `R2_RUNTIME_BUCKET`, secrets `R2_ACCESS_KEY_ID` and
  `R2_SECRET_ACCESS_KEY`, scoped to the public runtime bucket.

Stable and Nightly publish `lody-cloud-daemon`; staging/next publishes the separate
`lody-cloud-next-daemon` namespace. Both runtime routes must serve the configured
canonical bucket consistently. Never overwrite a published version, alter a digest
after upload. Manifests are trusted through the configured HTTPS download
service. SHA-256 checks detect corrupted artifacts, not replacement of both
artifacts and manifest by a compromised service; no release key pair is required.

Node publication tests run without cloud access;
production signing, complete cloud builds, R2 credentials and native platform
acceptance still require their actual CI environment. Unsigned Windows SEA binaries are runnable, but Windows reputation checks or
application-control policies can warn or block them. Signing is not a build
requirement. Windows remote update remains unavailable pending descendant-process
ownership support; this is independent of signing. Encrypted lifecycle control
also remains unavailable.

Managed lifecycle request tokens bind channel, timing and explicit confirmations.
After current owner verification the server issues a bounded execution ticket;
the Worker revalidates current access immediately before interruption. Ordinary
requests keep their short lifetime; execution tickets never renew themselves.

## Official standalone installer

The download Worker serves `GET /install.sh` and `/install.ps1` from these reviewed
composition-owned script files. The script's default download origin is rendered
from the origin serving it, so it follows the shared public artifact host without
another hard-coded mirror. `LODY_INSTALL_BASE_URL` is an explicit HTTPS mirror
(or loopback-only HTTP for isolated tests), not account configuration. No script
upload to R2, signing key or additional GitHub Secret is needed.

`GET /api/install/daemon/{channel}/{platform}` reads the existing R2 channel manifest,
checks the shared strict release schema and exact cloud product/distribution,
channel, platform and compatibility values, and emits `LODY-DAEMON-INSTALL-1` plus
10 newline-terminated fields: product, distribution, version, channel, platform,
capsule filename, compressed SHA-256, compressed size, raw SHA-256, raw size.
This small data format needs no JSON parser on a fresh Unix machine. The capsule
is verified before execution; its embedded Node identities independently verify
`node.gz`. Missing/incompatible releases fail before installation.

The UI passes the current build channel and pairing credential as quoted local
arguments. Public download requests contain neither credentials nor workspace
identity. `--no-start` / `-NoStart` installs without authentication or services;
normal use signs in, registers future autostart where supported, and starts the
fixed entry through the existing ready handshake. Generic interactive installation
uses the existing device-authorization flow. An already running Host requires
explicit migration; unknown services are preserved. An unavailable service manager
is reported while the initial daemon may still run. Linux non-root user services
need appropriate lingering policy for persistence after logout.

The installer also writes a marked `lody` command shim to `~/.local/bin` (or
`XDG_BIN_HOME`), and adds that directory to the user's shell or Windows user
PATH when it is not already present. A foreign `lody` is preserved and causes
shim/PATH setup to be skipped; `--no-modify-path` / `-NoModifyPath` or
`LODY_NO_MODIFY_PATH=1` keeps profiles and PATH untouched while still writing
the shim. Commands launched through the shim follow the selected managed
release after a remote upgrade, while daemon lifecycle commands remain on the
fixed service entry.

Each native publication job runs `install-native-acceptance.mjs` against its frozen
capsule and Node archive before uploading the platform artifact. Unix runs with an
allowlisted PATH containing no Node/npm/jq; PowerShell runs on actual Windows.
Downloads are deterministic local fixtures and installation uses an isolated data
profile. No daemon or credential pairing is started. The Windows task probe checks
unlimited duration/battery settings when task registration is available, and removes
only its uniquely marked test task. This is native installer evidence, not cloud
pairing, SSH-logout persistence, Agent, CDN or production update acceptance.

Client publication waits for both public installer scripts and the six platform
bootstrap manifests/capsule/Node downloads to be available. Stable/next app-only
releases may reuse an existing channel; historical recovery sources using npx do
not acquire this dependency. A successful new daemon publisher additionally binds
the check to its exact version. Nightly checks its reserved version. Cloudflare
Pages deploy builds perform the same availability check when the public input
contains the standalone installer UI; failures retain the previous deployment.
Local builds remain offline-capable. Deploy the download Worker before triggering
the first client release. This does not enable other product features.

### Detached installer signatures (deferred)

The current SHA-256 values detect corruption but are supplied by the same origin;
they are not an independent publisher signature. Adding optional signatures alone
would permit downgrade by omitting them. Keep this separate from Worker request
hardening until the release owner provisions the trust chain:

1. Generate an Ed25519/minisign key outside the repository; keep the private key in
   a release-only secret store and document rotation/recovery. Commit only the public key.
2. Sign frozen bootstrap metadata (including product, channel, platform, version and
   both artifact hashes) after native signing, before moving channel pointers. Publish
   detached signatures with the immutable version, and include Node artifact identity.
3. Pin the public key in independently distributed/reviewed installers; define a minimum
   signed release/cutover policy. Missing, invalid, mismatched and replayed signatures
   must fail before execution after cutover; support both shell and PowerShell.
4. Add deterministic tamper/missing-signature/rotation and real native acceptance cases
   before enabling the requirement. A script and key fetched from a compromised origin
   together do not establish an independent bootstrap trust root.

No detached-signature verification or new signing secret is enabled by the Worker
security PR; existing native platform signing remains unchanged.
