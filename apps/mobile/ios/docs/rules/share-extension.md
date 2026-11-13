# Share Extension (iOS)

Read before changing the Share Extension or the App Group snapshot it reads. These rules bind every caller of the area, not only files in its directory.

- `LodyShare` is declared in `project.yml` and compiles listed LodyKit sources by reference, guarded by `LODY_SHARE_EXTENSION`. It never runs the WebView, data runtime or network, and never reads Keychain.

- The app writes a credential-free App Group snapshot (`ShareStore`: catalog, cached options, prefs). Send writes an inbox entry and opens `lody://share/<id>`; `NativeShareCoordinator` drains entries into the ordinary outbox, and falls back to the pre-filled form when the selection is unresolved or stale. The link only wakes the drain.

- Before routing a queued share to another workspace, check its mode after matching the account and workspace membership. Unknown targets stay queued without switching or blocking later shares. Remove owned encrypted-target entries with the unsupported-workspace notice; ordinary plaintext entries continue through the existing delivery path.
