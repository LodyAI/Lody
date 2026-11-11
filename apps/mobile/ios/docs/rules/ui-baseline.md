# UI baseline (iOS)

Read before changing any native UI: text, colour, canvases, touch targets, grouped lists or page chrome. These rules bind every caller of the area, not only files in its directory.

- Shell pages use transparent headers and soft scroll edges. Native pages bind their scroll view through `LodyScrollEdges`.

- New surfaces should adopt the design system; other pages keep the system baseline until migrated. All copy goes through `Localizable.xcstrings` (en + zh-Hans).

- Apple HIG is the primary UI requirement. Chat references inform behavior only; preserve native conventions.

- Native text uses system fonts, with system monospaced fonts for code. Keep semantic sizes, weights and Dynamic Type in `LodyTextStyle`; do not bundle or select custom font families for native UI. Chat inline code uses body size and secondary-label ink, retaining link colours. Preserve fenced-code themes; with the current per-block renderer, containers holding fences retain their original code colours.

- Use fixed Ink for the app accent; do not expose an accent picker or read legacy accent preferences. Preserve conversation activity/status colors from the design system. Diff additions use systemGreen, paired with systemRed deletions. Use UIKit semantic content colors, Ink actions, neutral backgrounds, and explicit toast semantics: neutral information/completion, orange warnings, red failures. Preserve automatic dark mode and accessibility contrast adaptation.

- App-owned dark canvases use fixed soft `#111113`, never pure black; ignore legacy `darkBackground` preferences and do not expose a picker. Preserve light semantics. Camera and simulator media backdrops stay soft dark in either theme; masks, translucent scrims, shadows, artwork and foreground ink are not canvas fills.

- Preserve native navigation, safe areas, VoiceOver labels, and at least 44 pt touch targets. MVP acceptance uses the default text size; keep system text behavior but do not add special layouts or remount logic for oversized accessibility text.

- Reference Yohaku iOS for native UI boundaries. System grouped rows use `LodyGroupedList` / `UICollectionViewListCell` in LodyKit; navigation uses UIKit automatic scroll edges through the existing native stack. Register native collection views with UIKit directly; do not simulate native effects with decorative overlays.

- `LodyGroupedList` system-row pages default to flat rail rows; CreateSession and its pickers opt back into inset-grouped rows with `setGrouped(true)`.

- Navigating native list rows retain selection until the owning controller returns. Deselect alongside the navigation transition and restore selection when an interactive return is cancelled; ordinary action rows deselect immediately. Diffable snapshots preserve selection themselves; never reselect a captured row in snapshot completion, which can run after return-time deselection.

- Conversations own headers with soft edges; other pages retain native navigation.

- Pages write bar items to the hosting `LodyPageController.navigationItem`. Bottom toolbars appear only while their page is top; item updates wait for the running transition. Remove observers when their owner goes away; UIKit work runs on the main actor.

- `LodyFormController` editors use inline-label `LodyFormRow` rows in hairline-separated `LodyFormGroup` groups on `lodyGround`.
