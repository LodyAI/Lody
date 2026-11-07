# LodyCore

Local Swift package used by iOS LodyKit, the iOS Share Extension and AppKit.

`LodyCore` contains Foundation-only creation models, selection rules and runtime
health. `LodyRuntime` depends on WebKit and owns shared nonpersistent WebView
construction, bundled-document loading and navigation policy. It has no Expo,
UIKit or AppKit imports, and receives its handler, delegate and resource bundle
from the owning platform.

The platform still owns subscription lifetime, native message routing, watchdog
ticks, credentials and native services. iOS retains its existing data-runtime
facade and sender. The Share Extension links only `LodyCore` and continues running
without network or Keychain access.

Run `swift test --package-path packages/lody-core` from the repository root.
The existing native iOS verification runner also compiles this same package
module for host or Simulator checks.
