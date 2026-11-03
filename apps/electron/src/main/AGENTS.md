# Electron main process

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Parent [module rules](../AGENTS.md) apply.

Main authentication uses `auth-fetch.ts` with Electron Chromium networking after
app readiness. Preserve Better Auth cookie hooks and cancellation; never bypass
certificate verification. Behavior: [login Spec](../../../../specs/desktop-browser-login.md).

When `AuthService.getSession` retries a rejected renderer bearer using its durable
cookie, preserve the fallback's error/result. A network failure or 5xx must never
be replaced by the earlier 401: shared session verification would interpret two
such results as confirmed sign-out. Cached identity remains scoped to the auth
generation and is cleared by explicit sign-out or definitive session rejection.
The 5-second session timeout bounds the caller, not the request: a late resolved
answer seeds the cached session only if no answer, including a definitive
rejection, was committed after its request started (same generation).
`getSessionToken` treats an unreachable verification as no verdict and uses the
durable cookie (else the supplied bearer); it never starts a second check.
For local E2EE directory selection, `auth-storage.ts` also retains a token-hash/user-ID
binding in the existing auth config, with no time expiry. `getCachedSessionIdentity`
uses it only when the device cookie or supplied bearer matches; it never grants cloud
access or ledger authority. A matching supplied bearer can seed the in-memory token
for subsequent E2EE calls. Identity observers run only after confirmed auth changes;
transport uncertainty neither clears the binding nor publishes sign-out. Ordinary
renderer bootstrap snapshots retain their existing seven-day lifetime.

## Diagnostics

Resource links use `lody://` in every channel; startup never replaces an existing
default handler. Packaged Windows fills an absent handler on first launch. Forward
legacy cloud routes only to Stable's private alias, never through the common scheme;
OSS must not exchange cloud credentials. Callback schemes stay channel-specific. Validate session resources before
product-window dispatch, preserving the explicit workspace. Provider import links stay local to
the chosen installation and only stage user confirmation; never dispatch cloud auth or write
Provider settings from a URL. Contract: [Magpie import](../../../../specs/magpie-provider-import.md). See [deep links](../../../../specs/deep-links.md).

On a cross-channel desktop-lease conflict, hand a channel-neutral `session`,
`chat/new` or `provider/import` destination to the running owner over the bounded
lease before quitting. The owner acknowledges only after its launch handler is
bound; a refused startup rejects the handoff instead of acknowledging an unconsumed
buffer. Never hand off auth/cloud callbacks, and keep credentials and business
modules unloaded.

Main-process `console` output, lifecycle, and embedded-CLI supervision reach the
CLI daily log through `desktop-log.ts`; write synchronously, never persist
credentials (redaction is only a backstop), and trace CLI spawns without their
arguments. See the [tracing decision](../../../../.agents/notes/implemented/feature/2026-09-25-daily-log-crash-and-stall-tracing.md).

## Prepared windows

macOS local target preparation shares the opt-in spare's single slot. Bind readiness
to sender, target and generation; cancellation belongs to its source request.
Expire unclaimed views and destroy them on source close. Claim adopts identity and
reload target without remounting; activate renderer effects only after native show.
The [window Spec](../../../../specs/desktop-windows.md) owns the behavior contract.

## Startup theme

- A product window opens on the COMMITTED theme, not the OS appearance: `theme-settings.ts`
  feeds `getInitialMainWindowThemeSource` before the `BrowserWindow` exists (native frame
  and win32 overlay; the `.dark` class is the CSP-hashed boot script's job). A preview
  never reaches that store. Every `conf` store built at import or startup goes through
  `createSettingsStoreWithFallback` (`createMainSettingsStore` for new `userData` stores):
  `conf` validates in its constructor, so a malformed file would otherwise stop launch.

## E2EE key custody

`e2ee-custody.mts` selects Electron OS protection for core node-custody, which owns an explicit Scope, a wrapped KEK and
XChaCha20-Poly1305 protected blobs. It never joins the renderer IPC registry or
starts from application bootstrap. The explicit E2EE IPC methods create
or reopen an account-bound local pending request and workspace runtime; they expose public state and room-bound content seal/open; device access credentials stay in main, with no arbitrary signing or content-key export. It rejects local composition
before authentication/native access and checks the main-process account session.
The encrypted adapter enables Meta, Loro documents and the owning workspace/machine/Code Collab index and signal Flocks; unsupported rooms and plaintext side channels stay closed.
`e2ee-custody-electron.ts` is the readiness-gated native composition factory.
Reject unavailable native encryption and Linux `basic_text`/unknown backends;
never reuse auth cookie plaintext overrides or fall back to plaintext files.

New content seals prefer installed current keys inside core, never renderer hints.
Only genuine absence permits retained published keys within the durable fifteen-minute
observation budget; exhaustion fails for retry. Keep sealed old frames and history. See the [sealing decision](../../../../.agents/notes/implemented/architecture/2026-10-27-e2ee-epoch-receive-barrier.md).

All installed/candidate binding fields are authenticated AAD and encrypted in the
core payload. For new workspaces, use `prepareDevice` only for local genesis signing, then
`retainDevice(actualGenesis, prepared)` before any network/CAS; failed preparations
use `discardDevice` and never delete retained originals. Device private keys are
encrypted on disk and imported as nonextractable native handles; Recovery secrets have no persistence method.
Hand custody to `@lody/e2ee-core` only through `desktopE2eePorts` (KeyProtector,
CandidateProtector, DeviceIdentity); keep the two protection purposes distinct.
Caller-owned recipient handles must remain within the custody owner's Scope:
WebCrypto provides no deterministic handle destruction or JS-string erasure.
Stop admission before shutdown, await actual native work, then clear owned KEK
bytes. Failed opens preserve originals; no key deletion or migration. Interrupted
KEK rewrap recovers only a validated same-key wrapper under the native OS mutex;
never infer lock ownership from PID/age or generate a replacement KEK on failure.

`services/e2ee-bootstrap.mts` commits immutable creation intent and signed genesis
before retaining device/epoch keys. Return only after native device reopen and core
epoch commitment verification. Exact retries retain original bytes and metadata;
incomplete local writes, unknown remote outcomes and corruption must never trigger
replacement keys or deletion. SQLite owns the cross-process creation mutex; scopes
await admitted native work before releasing it. No network or plaintext data-plane
activation belongs in this host workflow.

The owning test uses synthetic authenticated safeStorage plus real crypto,
filesystem and another OS process. It does not prove an OS keychain or all-platform
packaging result; native safeStorage assurance needs an isolated platform run.

`e2ee.readIdentity` is an expected-account-bound local read of retained verified identity.
It grants no renderer reader/status/content capability. Preserve existing readers;
release a cold temporary host before replying. `status` still requires a window reader.

Team-member joining uses `services/e2ee-member-join.mts`: retain exact KeyPackages
and every signed admission before I/O. Unknown outcomes cannot replace them;
verify competing ledger bytes or a terminal server reservation before retirement.
New accounts replay genuine history from their independently retained genesis;
server labels never establish native identity. [Decision](../../../../.agents/notes/proposed/feature/2026-10-28-e2ee-team-joining-native.md).

Removal erases `member_joins` and `personal_join_histories`. All three join installs
clear the removed marker only after verifying a different retained signing key.
Only parsed HTTP 560 codes `e2ee_member_removed`/`e2ee_device_revoked` from explicitly
credential-bound endpoints may produce `E2eeMemberRemovedError`/`E2eeDeviceRevokedError`.
JWT, transport, parsing and unrelated endpoint failures never authorize cleanup,
even with matching codes or types. The account boundary projects typed results,
including causes, to their exact codes with the `accessLoss` marker.
Revocation uses the device-bound removal receipt and cleanup, records its reason,
and remains terminal until re-pairing replaces the key. Failed local operations,
including dispatch, confirm loss through this device's credential.
Dispatch still requires its calling reader. Temporary status hosts drain outside
the account lock on every exit, including failed identity rechecks, unless another
reader owns them.
[Decision](../../../../.agents/notes/implemented/architecture/2026-10-30-e2ee-desktop-device-revocation.md).
