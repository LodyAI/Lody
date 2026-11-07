# Sidebar presentation POC

Independent, offline UIKit app. Not wired into Lody's product pages.

The first three rows compare system form sheets, `sourceView`, and compact
traits. They do not strictly contain the sheet and its dimming inside the
sidebar. The fourth uses `UIPresentationController` with a sidebar-local frame.
The fifth toggles a bottom-anchored native Glass search field and add button.

The custom sheet is presented by the **navigation controller**, which owns the
search field too. Presenting from its child puts navigation chrome above the
sheet. Medium height reserves 10 pt side/bottom margins; dragging the header
expands to the sidebar bounds while those margins and corner radius shrink.
Dragging down restores the medium detent. Close and dimming dismiss the sheet.

This proves containment, header dragging and chrome ownership, not complete
iPhone sheet fidelity: no interactive dismissal, scroll-to-sheet gesture
handoff, opening/closing transition customization or Glass sheet material yet.
Rotation, multiwindow resizing and physical-device performance are not verified.

## Reproduce

Requires the existing Xcode 26, XcodeGen, AXe and ffprobe installations.
Run from the repository root with normal signing:

```sh
export LODY_POC_PROJECT=$(mktemp -d /tmp/lody-sidebar-poc.XXXXXX)
ln -s "$PWD/apps/ios/verification/kit/sidebar-poc/Main.swift" "$LODY_POC_PROJECT/Main.swift"
xcodegen generate --spec apps/ios/verification/kit/sidebar-poc/project.yml --project "$LODY_POC_PROJECT"
pnpm verify:simulator --name 'Sidebar POC' --device ipad -- zsh -euc '
  xcodebuild -project "$LODY_POC_PROJECT/SidebarPOC.xcodeproj" -scheme SidebarPOC -configuration Debug -sdk iphonesimulator -destination "id=$LODY_VERIFY_UDID" -derivedDataPath "$LODY_POC_PROJECT/build" build
  python3 apps/ios/verification/kit/sidebar-poc/verify.py "$LODY_VERIFY_UDID" "$LODY_POC_PROJECT/build/Build/Products/Debug-iphonesimulator/SidebarPOC.app" .artifacts/sidebar-poc/refined
'
```

The behavior check records both appearances, exercises all presentation modes,
drags medium → expanded → medium, checks containment and modal search exclusion,
then closes and types into the restored bottom search. Inspect the screenshots
and videos as well as the measured frames. Enable the Simulator software keyboard
to inspect keyboard avoidance visually.
