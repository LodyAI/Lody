# Static sharing protocol

The four `session-share-*.ts` files are vendored from the public Lody repository,
`packages/shared/src`, commit `559c3eb707cb8bdaed6dbf4c2fa9ccabf8959c3f` (AGPL-3.0-only,
same license as this repository). Only relative import extensions and formatting
are adapted. Keep capture filtering, attachment policy and manifest validation in
sync with upstream. No Lody root package or private backend is imported.

The iOS adapter runs these browser-safe files in the existing owned data runtime.
It uses uncompressed history, which the versioned desktop reader supports.
Authenticated control-plane calls and image downloads stay in Swift; long-lived
credentials never enter the WebView. Reader credentials are saved in Keychain
before publication. Upload credentials live only for the open editor.
