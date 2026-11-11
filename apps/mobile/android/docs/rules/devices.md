# Devices and installation (Android)

Read before building, installing, testing on or taking screenshots from any device or emulator. These rules bind every caller of the area, not only files in its directory.

- A request to rebuild or reinstall means a data-preserving update: build the APK and use `adb -s <serial> install -r <apk>` on the explicitly selected device. Preserve the application ID and signing identity so login, Keystore keys and cached data survive. If installation fails, diagnose it; do not fall back to uninstalling or clearing data.

- Keep the user's signed-in preview device separate from instrumentation testing. Run `connectedDebugAndroidTest` and other test installation/cleanup flows on a dedicated disposable emulator, with the target explicitly restricted to that emulator. These flows can remove application data; do not run them on the user's preview device.

- Rebuilding, reinstalling or taking screenshots does not authorize `adb uninstall`, `pm clear`, emulator wipes or credential deletion. Obtain explicit approval before clearing the user's device data. Never copy credentials between devices to work around a lost login.
