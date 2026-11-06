# Tailwind → StyleX migration guide

Move one owned surface at a time, preserving its rendered layout and behavior.
The product renderer and Storybook fixtures use StyleX and native integration CSS. The
[token reference](README.md) owns the shared vocabulary.

The independent [code-review helper](../../../code-review-helper/README.md) has
its own compiler configuration and CSS variables. Verify its real standalone
`file://` output as well as Storybook: extraction must precede single-file CSS
consumption, as documented by its
[build owner](../../../code-review-helper/standalone-build.md#style-extraction-and-single-file-output).
Its utility inventory is separate from this package's source count.

## Ownership and composition

| Concern                 | Owner                                             | Migration rule                                                                         |
| ----------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Theme values            | `theme-colors.stylex.ts`, `theme-scale.stylex.ts` | Preserve existing CSS variable readers and scales.                                     |
| Component styles        | Local `stylex.create`                             | Move a complete owned module and remove its utilities.                                 |
| Shared area styles      | Adjacent `surface.ts`                             | Share repeated structure, without a utility mapping layer.                             |
| Primitive customization | Its variant/size props and typed `xstyle`         | Compose the caller's StyleX inside the primitive's one `stylex.props` call.            |
| Native CSS hooks        | Their owning stylesheet                           | Keep scrollbar, animation, integration and group markers that still have real readers. |

The migration's endpoint is removal of Tailwind, its build plugins and its
runtime class-merging dependencies. Coexistence is temporary. Retaining source
utilities behind renamed exports or rewriting their declarations in Tailwind's
output does not remove that dependency. The former declaration bridge has been
removed together with its profile and build wiring.

Migrate actual in-repository callers with their owner. Do not hold an entire
module on Tailwind to preserve hypothetical arbitrary utility overrides. Preserve
real DOM/Slot structure, refs, events, theme values and rendered states; migrate
visual caller overrides to explicit StyleX composition. `className` remains useful
for integration hooks and already-composed native elements. It is not the
composition boundary between two independently generated sets of atomic styles.

The locked compiler supports scoped selectors such as `':is(*) > svg'`. Use them
when the component owns the descendants; keep semantic part props when callers
need to customize an owned part. Do not add global utility aliases or specificity
patches to imitate the old utility layer.

The application retains its existing CSS layer order. Product and Storybook
contain no Tailwind compiler input or plugin. `tailwind/reset.css` owns browser
normalization; `tailwind/theme-defaults.css` owns ordinary scale variables and
native safe-area hooks. Neither generates utilities. The historical directory
and stylesheet export names remain compatible with existing hosts.

Audit dynamic class maps and helper defaults as well as JSX. The compiler-backed
scanner was retired with its compiler after the final source snapshot reached
zero recognized utilities. Frozen inventories retain unresolved expressions and
their method; zero recognized count is not proof of runtime or visual coverage.
Inspect the actual desktop: an old-browser viewport fallback alone does not
provide normal `100svh` height.

## Compose props before rendering

```tsx
const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[3],
    borderRadius: themeRadius.md,
  },
  selected: { backgroundColor: themeColors.selection },
});

const props = stylex.props(styles.row, selected && styles.selected);
return <div {...withClassName(props, className)}>…</div>;
```

`withClassName` is the existing helper in `lib/stylex.ts`. Alternatively, merge
`props.className` with the caller's class using `clsx`. Never spread StyleX props
and separately supply an unmerged `className`, in either order: one silently
replaces the other. Combine style blocks in one `stylex.props` call rather than
spreading several independently; later StyleX arguments resolve property conflicts.
Merge inline styles too when dynamic StyleX variables and a caller's `style` share
an element.

A later declaration also replaces that property's conditional states. A
`color` override with a null default and only `:disabled:hover` can erase an
earlier `:hover` color. Keep the required normal, hover and disabled colors in
one composed property definition, then inspect each rendered state.

A media-scoped hover rule can outrank an unscoped active rule in compiled
StyleX. Scrollbar thumbs restrict that hover predicate to `:hover:not(:active)`
so a held pointer keeps the original active color. Compare the actual pressed
frame, not only rest, hover and the state after release.

Keep public props, DOM structure, conditions and event handling stable. This work
does not authorize redesigning controls, changing copy or altering layout semantics.

## Preserve the computed contract

| Tailwind behavior      | StyleX equivalent or verification                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Spacing                | `themeSpace[n]`, still coupled to `--spacing`.                                                                   |
| `text-sm`              | Both `themeFontSize.sm` and `themeLineHeight.sm`.                                                                |
| `font-mono`            | Font family **and** `fontVariantLigatures: 'var(--lody-font-ligatures, contextual)'`; the global hook owns both. |
| `truncate`             | `overflow: 'hidden'`, `textOverflow: 'ellipsis'`, `whiteSpace: 'nowrap'`.                                        |
| `flex-1`               | Preserve the `1 1 0%` basis, not only `flexGrow`.                                                                |
| `space-y-*`            | Preserve child margins and their interaction with explicit margins and existing flex gaps.                       |
| Responsive variants    | Match the original media condition, including fractional widths at a breakpoint.                                 |
| Alpha colors           | Preserve the exact compiled HSL or color-mix expression; see [Alpha](README.md#alpha).                           |
| `border` without color | Preserve the existing inherited/current color and border style.                                                  |

The current `px-*` utility emits `padding-inline`; verify the primitive's actual
compiled reader uses the same axis before moving the value into a public token.
Horizontal screenshots alone cannot detect an axis swap. Include vertical writing
when that is a relevant inherited/public contract.

Inspect dimension utilities too: the current `max-w-xs` emits literal `20rem`,
not a read of `--container-xs`. Preserve that literal while retaining local
spacing expressions where the actual utility reads them.

Inspect compiled font-family rules rather than assuming a utility reads the app
font variable. The current `font-sans` preset emits a literal native/Chinese font
stack; replacing it with `var(--font-sans)` selects the app's Inter stack and
changes comment layout. Keep the original family until a separate typography
change is intended and accepted.

Preserve runtime variables as well as their default values. The project editor's
`rounded-xl`, `font-medium` and `leading-tight` read `--radius-xl`,
`--font-weight-medium` and `--leading-tight`; some shared scale tokens contain
literal defaults instead. Keep the exact variable expression locally when that
token does not preserve the compiler contract, and verify nondefault variable
values in the browser. Do not change a shared token for one component without
checking its other consumers. `rounded-full` compiles to `calc(infinity * 1px)`;
a fixed `9999px` token can differ for a public component with unbounded sizes.

Keep private writes and physical readers distinct. The locked `tracking-wide`
rule writes `--tw-tracking`, but `letter-spacing` directly reads `--tracking-wide`;
`leading-tight` similarly writes `--tw-leading` while `line-height` reads
`--leading-tight`. Reading the private writer instead changes legal overrides.
Check token retention in a complete production build with diagnostic fixture
utilities removed before adding any static theme declaration.

An optional token fallback is not equivalent to an explicit physical declaration.
For `Card.Title`, aliasing tracking at the root loses a child's semantic override;
a nested token fallback fixes that default but changes an explicit invalid
`--tracking-tight` value from parent physical2px to semantic2.6px. The title's
optional `fontWeight` and `letterSpacing` props preserve the original expressions
as physical fields while omission keeps its live default reader. Keep the legacy
private writers local and test invalid, missing and inherited variables too.
The Vaul-backed `ui/drawer` Description has its own optional physical `fontSize`.
Omission keeps the original style object and default small-text line-height
reader. Explicit values set only font size; caller styles and Radix slotted-child
styles keep priority. Workspace sheets use it for0.78rem rather than duplicating
an ineffective StyleX declaration beneath a surviving utility. This is separate
from `@lody/ui`'s Base UI Drawer contract.

A literal invalid CSS assignment and a valid `var()` that becomes invalid at
computed-value time are different contracts. Real Chrome rejects a literal
weight0 update and retains an existing550, whereas a var() resolving to0
inherits its parent. DOM emulators may accept the literal; use browser output
for that contract rather than normalizing or clamping the value.

A `stylex.defineVars` value that references an app CSS variable resolves that
reference where the StyleX variable is defined. An inherited alias does not
re-read a descendant override. For a migrated declaration that previously read
`--spacing`, a radius or an ink variable on its own element, preserve that local
expression when the component supports scoped overrides. Compare both root and
subtree variable changes: a root-only custom-theme test cannot detect this
difference. A host that owns a complete isolated palette or spacing boundary can
instead apply `scopedThemeColors` / `scopedThemeSpace` at the element carrying
those CSS variables. These themes share the group's complete canonical defaults;
a partial replacement may reset omitted values. The share card uses this boundary
alongside its UI and conversation themes. Descendant overrides below that element
still require a local expression or another verified scope. Portalled content
needs its own scope probe. Keep shared-token changes separate until their consumers
have equivalent before/after evidence.

Type and spacing stay on their original rem scale. Moving them to `em` or
`--ui-font-size` changes interface font-size behavior. Preserve existing `em`
styles where the component already follows the interface size.

For `space-y-*`, inspect computed margins before converting. A sibling's `mb-4`
can override `space-y-1`; replacing that relationship with `gap: 4px` changes the
page. Preserve the nonlast-child writer and the actual margin winners, including
inherited, child-utility and inline reverse values. The current compiler lowers
camel-case `marginBlockStart` / `marginBlockEnd` to physical margins; quoted
`'margin-block-start'` / `'margin-block-end'` retain the logical axes. Verify the
emitted application CSS rather than assuming either spelling's output.

### Focus, ring and shadow

A private color/shadow carrier may serialize comma whitespace differently after
minification while every parsed physical field stays equal. Preserve both raw
strings and the exact diff; prove all actual CSS readers and compare complete
rendered fields. Only a named, demonstrated lexical difference may be classified
as equivalent. Never strip whole custom-property maps or ignore geometry, portal
state or attributes to manufacture equality.

The app has a base-layer inset focus indicator, but it also resets Tailwind's
focus ring variables and outlines with `!important`. A focused element with a
Tailwind `focus-visible:ring-*` utility therefore may have no visible ring: its
utilities-layer `box-shadow` overrides the base indicator while the ring itself
is transparent. Check the actual focused state before replacing it.

For such an element without a resting shadow, preserve the existing state with
`boxShadow: { default: null, ':focus-visible': 'none' }`. If a Tailwind shadow was
present, its shadow survived focus, so restate that shadow in the focus slot.
Do not apply this neutralization to `@lody/ui` controls, which own their focus
contract, or to elements that never had that Tailwind reset behavior.

A resting `ring-*` is visible. Move its ring and any shadow together into the
same StyleX `boxShadow`: a leftover Tailwind shadow would erase the new ring.
`focus-within` on an unfocused container is also visible because the global
`:focus` reset does not match that container. Preserve its ring. Do not drop a
ring or introduce a new one without inspecting its real state.

### Conditional outline properties

Declare forced-colors outlines with matching longhand conditions. Combining a
media-scoped `outline` shorthand with an unconditional `outlineStyle: 'none'`
can leave the atomic style reset winning in forced-colors mode. The Emoji Picker
regression required conditional `outlineStyle`, `outlineWidth`, `outlineColor`
and `outlineOffset`; verify the real forced-colors viewport and focused input.

### Ancestor and theme states

Semantic theme variables already follow light/dark mode and VS Code themes.
A hard-coded dark variant needs the app's exact selector contract before removal.
The current Tailwind variant matches `.dark` and `.dark-scope`, including descendants,
and excludes `.light-scope` and its descendants even beneath another dark scope.
For owned elements, the filter pill uses that complete self-element predicate in
its local StyleX property conditions. Preserve the compiler's fallback colours and
`@supports` values together, including local `--color-white` overrides. A light
`:hover` rule must not outrank the dark resting fill on a touch device: retain
dark 10% there and the original 14% only under `(hover: hover)`. Verify resting,
hovered and held states on actual fine/coarse browser descriptors.

The installed StyleX supports [`stylex.when` and markers](https://stylexjs.com/docs/learn/thinking-in-stylex/)
for observing an owned ancestor's state. Use that API when both marker and child
belong to the migrated surface. Do not replace app-wide `.dark` handling with
`prefers-color-scheme`: users can select a theme independently of the OS, and
nested light/dark scopes and portals must continue to work.

For an existing contract observing any external `.group` ancestor, preserve that
raw ancestor condition rather than narrowing it to a new owned marker. Inspect
the full compiled selector: the compiler may duplicate the StyleX class and
increase specificity. A zero-specificity `:where(...)` condition can preserve the
original total specificity, but it does not restore the old utilities-layer
priority. Keep actual public caller behavior and synthetic same-element negative
controls separate; an unavailable private class slot is not a general override API.

The default marker is shared across components. Qualify an ancestor selector
with an owned data attribute, as the project row and disabled context action do,
so an unrelated outer marker cannot reveal a nested control. Verify outer hover
and focus as well as the component's own hover and focus.

## Capture and verify a batch

1. Identify the owned surface and its real callers, including dynamic class maps,
   native hooks and Slot/render children. Historical compiler inventories are
   frozen evidence; do not reinstall Tailwind solely to count source strings.
2. Capture the unchanged component before editing. Verify the effective root theme
   and relevant computed palette: story-level globals can override URL globals,
   leaving a requested light frame dark.
   Prefer a fixed Storybook
   build. Give every candidate a unique output directory and log; only the actual
   build process exit zero plus matching final input hashes authorizes capture.
   Old completion text, early index files or a live server alone are insufficient.
   Include its important states, both themes, narrow/desktop widths and
   exact breakpoint boundaries. New stories render production components with
   synthetic data, never recreated approximations of the UI.
3. Migrate one owned unit, then run its behavior suites, component typecheck,
   formatting and `node scripts/stylex-review.mjs`. The review script is an aid;
   it cannot prove CSS equivalence.
4. Capture after with the same targets and Chromium. The harness waits for
   Storybook completion, fonts, finite animations and stable geometry. Capture
   rendering failures and fail the command instead of silently omitting them.
   Scope readiness selectors to the actual fixture; Storybook has hidden global
   headings, and a portal-only story can legitimately leave its canvas empty.
   Gate its real visible dialog, with an explicit allow-blank exception, rather
   than weakening painted-content checks for every story.
   Input selection and mirror state can commit separately: await selected-chip
   removal and matching scroll positions as well as the native caret. A Framer
   Motion panel can keep stable geometry at initial opacity zero; require its
   actual visible state before accepting an expanded frame.
   Use a real mobile device descriptor when device detection depends on UA or
   touch support; a narrow desktop window exercises compact desktop layout.
   Record explicit asset readiness and network conditions on both sides. An
   avatar fallback and a loaded avatar are different states, not a CSS diff.
5. Generate the self-contained HTML comparison, open it, inspect differences,
   and fix their causes. Preserve before frames when retrying after a fix.

From `packages/components`:

```sh
pnpm exec storybook build --output-dir artifacts/visual/build-before
node tests/visual/serve.mjs --root artifacts/visual/build-before --port 6017
node tests/visual/visual-regression.mjs capture --phase before \
  --storybook http://127.0.0.1:6017 --targets tests/visual/continuation-targets.json
# Serve the final build on a separate port, then capture the same target file.
node tests/visual/visual-regression.mjs report --before before --after after --name acceptance
```

Reports live in ignored `artifacts/visual/`. They embed their PNGs as data URLs,
include capture failures, and compare portalled content as well as the story root.
The pixel comparator reports summed RGB differences greater than 12/765; it also
compares geometry and computed type/color properties. An unchanged screenshot
alone does not prove behavior: exercise typing, disabled controls, keyboard focus,
hover, navigation, expanded content and file/error states where relevant.

A completed batch has verified production-component rendering and behavior,
working caller classes and CSS hooks, and an explicit list of compatibility
classes and unverified states. A larger migration remains incomplete until its
remaining inventory and unvisited application routes are addressed. Never present
passing stories as full desktop/backend end-to-end coverage.
