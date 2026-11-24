# Capacitor recovery vault and passkeys

The private iPhone account settings compose the existing shared account page with
an optional recovery panel. `src/recovery/recovery-account-setting.tsx` is selected
by the exact private Vite/TypeScript alias for the account route. It preserves the
ordinary account controls and lazy-loads recovery UI/crypto only when admitted.
The current public pin supplies `@lody/platform/e2ee-passkey` and the public core
vault/passkey workflows; private code never copies the Electron service tree.

## Opening gates and entry

Native iOS builds provide recovery by default, controlled at runtime by
`e2eeRecoveryVaultFeatureEnabledAtom`. There is no recovery environment build gate. The panel lives in **Settings → Account** on the
phone; it is not a server-selected route. The private wrapper does not replace
workspace administration or expose Electron IPC. The iPad wide-screen desktop
settings modal is not wired by this phone-route alias.

Passkey controls additionally require the private `LodyPasskey` plugin and its
native `LODY_PASSKEY_ENABLED=YES` build. Both App configurations default to
`NO`. Native availability requires iOS 18.4; the app's minimum stays 16.4. An old
OS or unavailable passkey implementation retains the recovery-file path.

Explicit native passkey builds select
`CODE_SIGN_ENTITLEMENTS=App/App.passkey.entitlements`. The ordinary
`App.entitlements` is unchanged, so default signing needs no new capability.
The opt-in plist adds only `webcredentials:lody.ai`; it adds no `applinks`
or website startup routing. The owner supplies the profile for
`YTRMX32C99.ai.lody.mobile` and deploys/configures the association separately.
Recovery enablement does not enable native passkey signing, a backend switch or deployment.

## User operations and authority

- Opening uses an explicitly selected recovery file or a discoverable passkey.
  Native PRF and UV evidence is verified by the public `unlockVaultWithPasskey`
  flow, then core authenticates the encrypted index. The UI sees only workspace
  count and passkey entry IDs/labels, never an unlocked session or key material.
- Adding asks for a user name (trimmed/collapsed, at most 64 characters) and the
  recovery file, then runs public registration plus a real assertion of that same
  credential. PRF/UV failures do not create a usable wrap. The default label uses
  device family and OS version, never the device hostname.
- Removing requires explicit confirmation of the copied-wrap limitation and
  reopens the vault with a freshly selected file or native assertion. Core commits
  the index before deleting the wrap. Only confirmed completion shows success.
  A failed/ambiguous removal keeps the warning and does not claim revocation.
- Confirmed add/remove commands return completion without a follow-up summary
  read. The UI clears the old list and preserves the completed-change notice.
  File-based changes separately refresh with that still-owned file; a failure
  shows a list-refresh warning with file/passkey read-only retries, not another
  registration/removal. Native removal offers explicit refresh instead of
  automatically prompting for a second assertion. File bytes are wiped after
  the separate read settles. Protocol-required deletion/readback and key cleanup
  remain part of the command, never downgraded to optional refresh.
- The console Recovery tab can create a vault using an offline file, native passkey
  or Argon2id password through public core. Password and file paths work on iOS 16.4;
  unavailable passkeys do not block them. Existing per-workspace setup/restore borrows
  the application runtime and preserves verified admission and key-readback rules.
- File creation and later offline-file backup use Capacitor Filesystem Cache and
  the system share sheet (choose Save to Files). A fresh explicit tap selects the
  saved `.lodyrecovery` file. Exact byte verification precedes uploading its wrap;
  cancellation or mismatch cannot create a stranded vault. iOS removes temporaries
  after the native share call settles, including failure/cancellation. Android retains
  them because chooser completion can precede the receiving app reading its URI;
  the next export removes prior recovery temporaries, including those from a prior process.
  Files are not held in React state. OS eviction may also clear Cache temporaries.
- Account settings still manage unlock/passkeys only. Whole-vault replacement is
  unsupported on mobile; opening a vault is not device recovery acceptance.

## Ownership and failure behavior

One account plus login session owns a controller. Native iOS/settings admission and
that exact owner are checked before and after native/cloud work. Retirement,
logout, account/session change or disabling the setting rejects late results and
subsequent writes. Independent capability/security-feed reads never hold the
vault-command permit, so unavailable activity cannot block file/passkey use.

Vault commands serialize until actual native/network/IDB completion. UI dismissal
never releases raw work early. Public Scopes wipe V/PRF; the private operation
also retains final cleanup ownership of every native PRF result, including early
public validation failures. Private file copies are wiped on every exit, including
file-picker/read races. Nothing logs native detail
or persists file bytes, U, V or plaintext keys. The public cancellation class is
preserved by the Capacitor port and displayed silently by the UI.

`src/e2ee/recovery-journal.ts` stores only public-protocol pins/intents under
`lody-e2ee:mobile:recovery:v1:<account>`. Every transaction requests **strict**
durability; CAS compares, writes and reads back within one transaction and reports
completion only after commit. Reopen preserves originals. Unsupported, blocked,
corrupt or failed storage never becomes an empty replacement journal. An owner
change leaves the old account's retained journal untouched.

Account activity reads `accountSecurityEvents.list({ limit: 25 })` for the live
account and shows at most five known events. Projection keeps only `kind` and
`occurredAt`; IDs, unknown kinds, malformed times, navigation and arbitrary extra
fields are ignored. There is no acknowledgement mutation, remote destination,
notification transport or delivery claim in this client change.

## Validation and remaining prerequisites

Focused tests use real core vault encryption, the real Convex client serializer,
synthetic backend/native ports and fake IndexedDB. They cover runtime-disabled, valid
PRF enrollment/unlock/removal, refusal/cancellation, session changes and strict
journal failure. Component previews use the real panel with synthetic ports;
keyboard-sized screenshots are simulated, not native keyboard acceptance.
The native plugin is compiled/linked with the actual Capacitor framework and
Xcode iOS simulator SDK at minimum 16.4. These are distinct evidence boundaries.

The current public pin supplies vault creation with passkey/password, offline-file
wrap creation and passkey-removal retry. This change does not modify that gitlink.
File export tests use synthetic native ports; native Save to Files, iOS 16.4
WKWebView and full device restore remain separate acceptance requirements.

Real profile/signing/install, Apple CDN association, iCloud Keychain, registration
and assertion PRF, device cancellation/second enrollment, persistent native
storage and real recovery remain owner acceptance. No acceptance stack is started.
