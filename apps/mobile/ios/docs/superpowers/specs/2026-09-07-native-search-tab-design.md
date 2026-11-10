# Native search tab

## Problem

The search tab was a disabled action trigger that pushed a full-screen `/search` route backed by `LodySearchBar`. On iOS 26 the tab bar never morphed into the system search field.

## Decision

Keep Expo Router `NativeTabs`. The search tab becomes a real route with its own native Stack, and the screen declares `Stack.SearchBar` with `placement="automatic"`. react-native-screens forwards `allowToolbarIntegration`, so on iOS 26 UIKit merges the search field into the tab bar when the search tab is selected.

A LodyKit-owned `UITabBarController` with `UISearchTab` was built and verified first (auto keyboard on selection, auto-restore of the previous tab on cancel), then dropped: it required raising the deployment target to iOS 26 for `automaticallyActivatesSearch`, and the collapsed previous-tab pill on the left of the search field is system behavior that no public API removes, so the extra native layer bought too little.

## Routes

- `src/app/(tabs)/_layout.tsx`: `NativeTabs` with `sessions`, `settings`, and `search` (`role="search"`).
- `src/app/(tabs)/search/_layout.tsx`: native Stack with the shared transparent header and soft scroll edges.
- `src/app/(tabs)/search/index.tsx`: exports `SearchScreen`.

## Search screen

`src/features/sessions/SearchScreen.tsx` renders `Stack.SearchBar` (`placement="automatic"`, `hideWhenScrolling={false}`, Chinese placeholder) and `NativeGroupedList` with `searchSections(catalog, query, colors.accent)`. `onChangeText` sets the query, `onCancelButtonPress` clears it. `openCatalogRow` opens results.

## Deletions

- `src/app/search.tsx` and its entry in the root Stack
- `src/app/(tabs)/search-action.tsx`
- `modules/lody-kit/ios/Chrome/LodySearchBar.swift` and its registration in `LodyKitModule.swift`
- `modules/lody-kit/src/chrome/NativeSearchBar.tsx` and its export
- `modules/lody-kit/verification/search-bar`

## Verified on the iOS 26.5 simulator

1. Tapping the search tab morphs the tab bar into the integrated search field with the search screen behind it.
2. Focusing the field shows the cancel button; typing filters results; tapping a row opens the session.
3. Cancel clears the query and keeps the search tab selected; tapping the collapsed sessions pill returns to sessions with its header title intact.

## Known limits

- The keyboard does not open automatically on tab selection, and cancel does not jump back to the previous tab. Both need `UISearchTab.automaticallyActivatesSearch`, which react-native-screens 4.26 does not use (upstream issue #3999, closed as not planned).
- The collapsed previous-tab pill left of the search field is iOS 26 system behavior.
- Wrapping inactive tabs in `react-freeze` hides the Stack's RN-rendered title (`Stack.Title asChild`) and it does not return after unfreezing; do not add tab-level freezing.
