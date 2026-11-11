# Shell and pages (iOS)

Read before changing the shell, page hosting and presentation, navigation, deep links, page factories or the Debug page. These rules bind every caller of the area, not only files in its directory.

- `LodyShell` owns the root navigation controller and sheet navigation controllers. `LodyPageController` hosts native content, carries results and clears callbacks on close. Reuse `pushNative`, `presentNative`, `finish` and `close`; do not add a second presentation manager. Conversation file routes retain per-path ownership until the preview closes (including interactive dismissal), not merely until presentation returns; different file paths remain independent.

- Deep links are parsed by `LodyCore.AppLink` and routed by `LodyApplication`. Notification navigation validates account, workspace and session catalog before opening a session.

- `HomeController` owns the adaptive UIKit split and list, session and inspector navigation controllers. Preserve native interactive pop. `SessionNavigation` handles session actions; tool pages use `LodyShell.presentDetail`. Keep sheets for transient flows and Debug demos.

- Register page factories in `Shell/LodyNativePages.swift`. Controllers read Swift-owned state and observe NotificationCenter changes. Inject service closures for I/O; offline preview subclasses use scripted services. Use `String(localized:bundle:)` with `.lody` and edit `packages/LodyKit/Sources/LodyKit/Resources/Localizable.xcstrings` directly. Use Foundation format arguments and catalog plural variations; `InfoPlist.xcstrings` owns permission prompts.

- Keep fault injection, runtime internals, and navigation/native demos on the development-only Debug page, reached from Settings. Product screens expose actionable connection state only.
