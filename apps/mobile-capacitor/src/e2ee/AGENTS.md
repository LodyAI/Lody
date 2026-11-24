# Native personal-device composition

Parent mobile and repository rules apply. Edit `AGENTS.md`, not `CLAUDE.md`.

- Reuse the public personal host and shared cloud client ports. Native custody
  only adapts `LodyKek`; it grants no approval and never falls back to browser or
  memory-only protection. Plugin presence and v1 availability are not admission.
- Creation signs the genesis with this device under a private creation scope, then
  binds the real workspace only after the authenticated create response. The phone
  approves a desktop's account-pairing request through the existing portable
  approver; it never returns private keys or a generic signer.
- As a new device, the phone requests account pairing over the account's workspace list
  and history (`requester`); the relay's account is the current runtime login, never a
  placeholder.
- `../e2ee-pair-link.ts` publishes OS-opened `lody://pair/…` and `lody://auto-pair?…` links
  (at most 512 characters) on `window.__LODY_PENDING_E2EE_PAIR_URL__` and the
  `lody:e2ee-pair-url` event for the shared pairing surfaces. These links carry a pairing
  secret, so they are never logged or reported, and other links pass untouched. Any app can
  open such a link: consumers treat it as untrusted input (`auto-pair` only prefills on an
  idle approval dialog, `pair` stays queued until a ready join page stages explicit
  confirmation), never inspect, submit, or approve on their own, and clear the global once read.
- Capture account/workspace/genesis/device/installation before native calls. Save
  installation intent and first exact wrapping originals before exposing success;
  unknown outcomes preserve the original and cannot re-wrap or replace identity.
- A missing native key/marker is not empty storage. Check complete and pending
  wrapper originals before committing installation intent in the same transaction.
  Never recreate that identity's KEK over residual or malformed records; preserve
  valid other installations without blocking a new explicitly prepared identity.
- Keep the writer, Layer and borrowed bytes until actual native settlement. App
  close retains complete A5 incomplete-close owners; only confirmed successful
  drain allows a replacement. Independent bindings remain independent.
- Normal reopen, logout, cache recovery and blank-screen recovery never create or
  delete keys. Only explicit scoped reset or authenticated removal may delete,
  after drain and comparison of the complete incarnation.
- No generic file/signing bridge, native error text, secret logging or plaintext
  persistence. Machine-policy support is absent until a real portable host exists.

- `makeMobileRecovery` remains the vault controller used by the account screen.
  `makeMobileRecoveryWorkspaces` is the same shared per-workspace engine as Web,
  with `platform: 'mobile'` fixed; only the console's recovery port
  (`../recovery/recovery-port.ts`) uses it, over the app's existing runtime.
- Both wrappers fix the recovery file locator to the canonical origin of `VITE_SITE_URL`,
  defaulting to Lody Cloud, so phone files match desktop and Web. Never derive it from the
  WebView origin, the Convex URL or the account.
- `LodyPasskey` implements the public passkey port behind its native signing/build
  flag and runtime recovery setting. Native iOS recovery itself is enabled by default. Keep actual native completion owned,
  never add a browser passkey fallback, and retain the original default signing
  plist. Recovery journals hold only protocol pins/intents in strict transactions;
  capability/security-feed reads never block vault commands. [Contract](../../e2ee-passkey.md).

- `LodyIroh` is the only native iroh plugin. The portable host hands it the device
  seed once per session through `withTransportSeed`; the plugin exposes open, status, selected connection path,
  send and receive, never returns the seed, rejects with fixed codes and relies on
  `loggingBehavior: none`. Relays come only from `VITE_IROH_RELAYS`; a build without
  relays or bindings keeps encrypted Streams RPC ([transport rules](../../../../packages/iroh-native/AGENTS.md)).
  iOS imports the optional local `LodyIrohBindings` Pod; sync after changing
  generated binding availability. [Build integration](../../BUILDING.md#optional-native-iroh-binding).
