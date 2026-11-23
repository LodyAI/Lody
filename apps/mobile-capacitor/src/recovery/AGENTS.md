# Private mobile recovery settings

Parent mobile and repository rules apply. Edit `AGENTS.md`, not `CLAUDE.md`.

- The phone Account route is composed through the private exact Vite/TS alias.
  Preserve all shared account controls and keep recovery UI/crypto lazy and behind
  native iOS/Android admission and `e2eeRecoveryVaultFeatureEnabledAtom`. No recovery build flag is required.
- Bind state and every asynchronous result to account plus login session. Disabling
  the setting or leaving that owner must prevent later writes and publication;
  no React state holds a recovery file or unlocked vault.
- Only public core workflows may interpret PRF/UV, decrypt the vault or update its
  index. The panel owns explicit file selection, names and removal confirmation.
  A failed/ambiguous removal is never success or proof of revocation. Confirmed
  add/remove completion must survive a later list-refresh failure: invalidate the
  old list, preserve success, and retry only the read with a fresh unlock.
- Security events retain only known kind/time pairs. The client owns navigation;
  never trust a server-provided route or expose unknown kinds as a known event.
- The encryption console's Recovery tab is the shared section over
  `mobileRecoveryPort`, supplied by `MobileRecoveryHostProvider` under the same native iOS/Android
  admission and runtime setting, one port per login. Its engine loads on first use. It creates vaults with files, native passkeys or Argon2id passwords and can add an offline file to a passkey/password vault. Whole-vault replacement remains unsupported. Account settings keep
  `RecoveryEntry`: it needs no encrypted workspace and manages passkeys by passkey too.
- Use existing shared primitives/copy and keep synthetic previews out of Git.
  [Entry, lifetime and acceptance boundary](../../e2ee-passkey.md).

- `recovery-file.ts` writes at most 4 KiB to a unique Capacitor Cache file, shares
  only its URI. iOS removes it after native settlement (including cancellation);
  Android retains it for the receiving app and deletes prior recovery temporaries before the next export.
  The provider asks for a fresh tap to choose the saved file; only exact readback
  allows core to upload the file wrap. No file bytes or unlocked vault enter React state.
  Logout/setting changes fence export, readback and every cloud write. Native passkeys
  still require the plugin/signing opt-in and iOS 18.4; file/password paths support 16.4.
