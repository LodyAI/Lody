# Scroll edge ownership

LodyKit owns scroll edge policy. Native UIKit scroll views receive their styles
directly, because RNSScreen's first-descendant lookup cannot reliably find them.
RN scroll views use ScrollViewMarker with presets exported by LodyKit; navigation
options use the same kit presets when the framework can reach its content view.

- Navigation content: soft top and bottom.
- Native chat transcript: automatic top and bottom. The embedded composer
  attaches with the same automatic bottom style.
- Native grouped lists: soft top and bottom, preserving their current appearance.
- iPad panels: navigation edges, hidden horizontal edges.
- A floating composer on new-session sheets and Diff explicitly configures its
  target scroll view's bottom as soft whenever it attaches.
- UIKit still owns material rendering, keyboard geometry and edge shape.

Verify a fresh native binary with offline chat and composer scenes in light/dark,
with content under the input and the keyboard raised. A successful build or a
style property alone does not establish visual correctness.

## Verification

On Xcode 27.0 (27A266a), the signed Release Simulator build passes the offline
`scroll-edge` case in light and dark mode. Visual review confirms progressive
blur beneath the composer both at rest and above the software keyboard.
Screenshots and video are in `.artifacts/scroll-edge-native/`.

The native `composer` check covers enabling soft occlusion on attachment,
replacing the target scroll view, and releasing the target on detachment.

Extended UI checks are not fully green: `home` cannot find the expected workspace
avatar label, and `composer-glass` encounters simulator automation/focus failures.
These runs do not establish full host acceptance. Additional host verification is
recorded below; unverified cases must not be inferred from the shared policy.

## Page and sheet audit

| Host                     | Coverage / change                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared `Screen`          | Item details, permission forms, workspace/settings editors, license text and errors use RN ScrollViewMarker with the kit preset.                                                                           |
| Native grouped lists     | Settings, pickers, projects, files, activity, model options, archived sessions and creation forms configure their own UICollectionView. Late binding notifies sibling composers.                           |
| Native sheet navigation  | Both the root and pushed levels of SheetStack now use the full kit preset, including hidden horizontal edges.                                                                                              |
| Onboarding               | Its standalone RN ScrollView now has a marker and automatic content insets. The action footer remains outside the scrolling viewport.                                                                      |
| Paged creation forms     | LodyPagedList publishes the visible child's scroll view to the outer sheet on attachment and completed page changes. Cleanup only removes the matching registration.                                       |
| Code / Markdown files    | LodyCodeView binds the active native source/document scroll view.                                                                                                                                          |
| Full Diff                | NativeDiffSurface scopes WKWebView discovery to the diff's own children, registers its scroll view and binds the floating native toolbar. Content completion triggers rebinding for a late/shared WebView. |
| Photo selection          | The native grid owns its edge configuration; its floating confirmation button binds only while a selection exists.                                                                                         |
| iPad / native prototypes | Sidebars use native ownership. Native prototype controllers register both vertical edges.                                                                                                                  |

Horizontal code/table scrolls, attachment strips, input text scrolling, image zoom,
inline mention suggestions and context previews do not own page navigation chrome.
They are intentionally excluded from page-level scroll registration. Offscreen
runtime WebViews are also excluded; the Diff host does not search outside itself.

`verify:native --case scroll-edges` checks nested-page publication, replacement,
and guarded cleanup. `verify:ui --case scroll-edge-pages` exercises the production
paged form and shared composer in a resettable offline fixture.

### Audit verification

- Signed Debug and Release Simulator builds pass on iOS 27. The final `pnpm check`,
  `pnpm bundle`, and `git diff --check` pass.
- Native `scroll-edges` and `composer` checks pass, including guarded page cleanup
  and photo-grid registration with no confirmation occlusion before selection.
- `scroll-edge-pages` passes in light and dark mode. Visual inspection confirms
  progressive soft blur beneath the composer after switching pages and scrolling;
  keyboard and return-page captures are retained in `.artifacts/scroll-edge-audit-pages/`.
- `onboarding` passes in both appearances, in `.artifacts/scroll-edge-audit-onboarding/`.
- `scroll-edge-diff` passes in both appearances after waiting for the real document
  completion event. Visual review confirms progressive blur beneath the native toolbar
  in Unified and Split modes. Evidence: `.artifacts/scroll-edge-diff-completion/`.
- The extended `settings` case is not fully passing. The light run reaches machine
  edit/save, then remains on the machine page after its return swipe. Evidence is
  retained in `.artifacts/scroll-edge-audit-settings/`; this is not full settings acceptance.

Native mock file/settings fixtures activate under `--ui-verify` in Debug and
Release fixture builds. A production TestFlight launch never passes that argument.
