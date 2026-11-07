# Swift → Rust interoperability probe

Verified on 2026-09-06 in a signed Debug build on the iOS 26.5 arm64 simulator.
This is a standalone verification app, not an integration into LodyKit's production module.

## Result

- JS `loro-crdt@1.15.1` generated a synthetic snapshot and concurrent text/map updates.
- Official `loro-swift@1.13.3` imported them through UniFFI into native Rust and matched the JS projection.
- Reversed and duplicate updates converged; deletion was preserved.
- Malformed binary input returned an error without crashing the app.
- A native text edit exported as an update was imported by JS WASM and matched the expected result.
- No WebView, remote workspace data, account credentials, or captured transcripts were used.

The Swift package tag resolves to `625f3e696fca4be3ae77de8b3404fa6753554f21`.
Its Cargo manifest declares `loro-ffi = 1.13.7`; the Swift package version is not the Rust core version.
The official prebuilt XCFramework SHA-256 was verified:
`fc55bfb84753a1f0d7ed130d5b03edf3745b6e3db1d62685eeddb77598e09be2`.
This verifies native binding/runtime interoperability for these operations, not a Rust-from-source build or all newer Loro features.

## Reproduce

Requires Node, Xcode, XcodeGen, and a booted iOS simulator. Run from this directory:

```sh
mkdir -p .work
git clone --depth 1 --branch 1.13.3 https://github.com/loro-dev/loro-swift.git .work/loro-swift
test "$(git -C .work/loro-swift rev-parse HEAD)" = 625f3e696fca4be3ae77de8b3404fa6753554f21
npm install --prefix .work/js --save-exact loro-crdt@1.15.1
node fixtures.mjs
xcodegen generate
PROBE_SIMULATOR=30639638-6CAE-43D5-BC8F-8B022D3C534F
xcodebuild -project LodyNativeProbe.xcodeproj -scheme LodyNativeProbe -configuration Debug -destination "platform=iOS Simulator,id=$PROBE_SIMULATOR" -derivedDataPath build build
xcrun simctl install "$PROBE_SIMULATOR" build/Build/Products/Debug-iphonesimulator/LodyNativeProbe.app
xcrun simctl launch "$PROBE_SIMULATOR" ai.lody.mobile-native-probe
```

After the app shows PASS, check the native update in WASM:

```sh
probe_data=$(xcrun simctl get_app_container "$PROBE_SIMULATOR" ai.lody.mobile-native-probe data)
node fixtures.mjs "$probe_data/Documents/result.json"
```

The second command must print `PASS: Swift/Rust iOS update imports into JS WASM and converges`.

## Flock remains unverified

`@loro-dev/flock-wasm@0.4.3` identifies itself as Rust WASM bindings, but its published package contains no Rust sources, repository URL, or git revision. The referenced `loro-dev/flock` repository returns 404 with the current GitHub account. No local source checkout was found, and the user confirmed they have no source location.

Consequently this probe does **not** prove that the current Flock decoder can be replaced by a native binding. We need the corresponding Flock Rust source or an official iOS library and API before testing binary compatibility. Loro and Flock are different engines; this result is not a substitute for that test.

Production WebView decoding and Cloud authentication remain unchanged. Full document schemas, persistence/recovery, device builds and performance are outside this probe.
