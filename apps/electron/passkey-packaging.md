# Optional vault passkey package

Default builds remain unchanged. This does not deploy `lody.ai`, enable a
runtime/UI entry. It prepares the cloud Mac packaging
contract from public draft [#2395](https://github.com/LodyAI/Lody/pull/2395).

The owner can opt in on a Mac with `LODY_ENABLE_PASSKEY=1`. Supply both:

- `LODY_PASSKEY_ADDON_DIR`: absolute directory containing
  `arm64/passkey_bridge.node` and/or `x64/passkey_bridge.node` for **every** selected
  `--arm64` / `--x64` target. Build them against the selected Electron headers as
  described in `apps/electron/native/passkey/README.md`. Packaging checks
  each Mach-O architecture with `lipo`. Universal packaging is not supported.
- `LODY_PASSKEY_PROVISIONING_PROFILE`: absolute path to an owner-provided Developer
  ID provisioning profile granting Associated Domains for Team `YTRMX32C99` and
  App ID `ai.lody.desktop`. Keep it outside source control. Electron-builder's Mac
  signing flow embeds it. The owner must verify profile contents, expiry and the
  signing identity before publishing.

The addon lands at `Contents/Resources/passkey_bridge.node`, outside ASAR, for the
public native loader. Electron-builder signs enclosed Mach-O binaries with the
selected app identity. Generated main entitlements extend the public base with
`webcredentials:lody.ai`, the application identifier and team identifier.
The main app retains library validation. Helper entitlements remain the public
inherit file and receive none of these vault rights. Windows, Linux and Nightly
app identifiers cannot opt into this association.

The hook generates files in the per-invocation temporary config directory and
removes them after packaging. It never edits the public source or its plists.

Local tests validate packaging plans, selected architecture checks and generated
entitlements. Signed installation, notarization, provisioning and real passkey
acceptance require the release environment and a real device.
