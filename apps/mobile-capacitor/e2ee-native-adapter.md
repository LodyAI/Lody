# Native personal-device custody adapter

`src/e2ee/native-custody.ts` supplies the public `ClientKeyCustody` and
`ClientIdentityOriginals` Layer over the existing five-method `LodyKek` plugin.
The application supplies the complete binding, persistent installation/pairing
stores and public custody writer. This adapter does not approve a device or
enable the app's runtime entry.

The prepared installation and native intent precede native work. A short IDB
transaction validates retained wrapper keys/records and proves this installation
has no complete or pending original before committing installation intent.
Residue or unknown state preserves originals and refuses KEK recreation. Valid
other installations remain independent. Exact first ciphertext is saved/read back;
an unresolved native result cannot be rewrapped after restart.

Native calls retain their writer and Scope until actual settlement. Wrap owns and
wipes its copy; abandoned unwrap output is wiped. The public host owns atomic
plaintext acquisition/cleanup and bounded retirement. Logout, ordinary cache
cleanup and close never delete identity. No browser or memory-only fallback exists.

The native policies and frozen v1 vectors remain in [iOS custody](e2ee-custody.md)
and [Android custody](e2ee-android-custody.md). `test:e2ee` uses real public IDB/writer
ports with synthetic AES-GCM native responses. It proves adapter behavior, not
Keychain/Keystore, hardware or installed-app acceptance. Product validation uses
test-build; stable publication and configRevision restoration are outside scope.
