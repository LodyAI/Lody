# Tailwind → StyleX migration guide

Move one owned surface at a time, preserving its rendered layout and behavior.
Tailwind remains available for unmigrated consumers and documented compatibility
cases. The [token reference](README.md) owns the shared vocabulary.

## Ownership and cascade

| Concern               | Owner                                             | Migration rule                                                                                                |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Theme values          | `theme-colors.stylex.ts`, `theme-scale.stylex.ts` | Read the existing app CSS variables and scales.                                                               |
| Component styling     | Local `stylex.create`                             | Put each rule on the element it styles.                                                                       |
| Repeated area styling | Adjacent `surface.ts`                             | Share actual repeated structure, without a utility translation layer.                                         |
| Control appearance    | `@lody/ui` primitive                              | Keep its variant/size API; preserve existing visual overrides until a separately verified replacement exists. |
| CSS hooks             | Their owning stylesheet                           | Preserve animation, scrollbar, drag-region and integration classes.                                           |

The app orders `@layer theme, base, stylex, components, utilities`. A remaining
Tailwind utility overrides StyleX on the same property. Delete a utility when its
replacement is verified; leaving it masks the migration. Two StyleX classes on a
primitive can also conflict: CSS generation order does not guarantee that a
caller's `minHeight` wins over the primitive's own `minHeight`. Do not remove a
working compatibility class merely to lower the inventory count.

Moving an attribute variant into StyleX also moves it ahead of every remaining
caller utility. The old attribute selector may have beaten a plain caller
class within the utilities layer. Preserve that variant until caller precedence
is verified, including public adapter callers beyond the current app.

Verify an override in every control state. The archive button becomes
`position: relative` while confirming; its caller retains `absolute z-20` so
the confirmation still overlays the end slot. Removing that compatibility can
shrink the title column even when a short-title screenshot looks identical.
Compare slot geometry and a clipped long title as well as pixels.

Inspect custom-property declarations in the complete application build as well
as ordinary properties. The locked StyleX compiler groups variable rules with
root/theme declarations; that group can be emitted outside CSS layers even when
an isolated component probe puts the same writer inside `stylex`. This changed
both a CollapsibleCard `--tw-shadow` override and the private message content's
`--tw-space-y-reverse` override. The rejected spacing candidate changed a real
utilities-layer reverse writer from start/end margins `12px / 0` to `0 / 12px`.
Those utilities remain until their complete writer/reader cascade can be preserved.
The card likewise retains its paired `shadow-none ring-0` compatibility classes
so `cn` can resolve caller overrides. Moving only the visible property or only
its variables does not preserve that composition contract.

When a repeated override is owned by a primitive, migrate through its explicit
API. Spinner's `diameter` sizes its turning wrapper while keeping SVG attributes
and named sizes separate. Pass the original local spacing expression when the
utility read it there; replacing it with an equal-default inherited alias changes
subtree behavior. Verify explicit zero and removal of the override on the same
mounted control, as well as its actual animation and rendered pixels.

Local primitive themes need their own inheritance check. `createTheme` also
applies the variable group's defaults: a partial Button theme reset an inherited
23px gap and 3px orange focus ring. Explicitly inherit every non-target token with
a complete typed key map. Keep that map in the compiler owner: the locked StyleX
0.19 compiler silently omitted an ordinary cross-file object spread, while
literal fields and a same-file local spread emitted the expected `inherit`
declarations. The resulting default-group class reset parent colors, gap, radius
and text size even though default-theme screenshots matched. Inspect the actual
full-build declarations and test nondefault parent tokens before accepting a theme.

For a few existing public tokens, component-owned `stylex.create` declarations
such as `[button.paddingXSmall]: 'calc(var(--spacing) * 2.5)'` can write only the
target variables without attaching a default-group class. They still require a
full-build cascade check. An element already carrying a theme may have stronger
variable declarations; merge spacing and appearance into one complete theme in
that owner instead of stacking themes or increasing selector specificity. Preserve
element-local variable reads and compare every non-target token, not just the
changed padding or gap.

The message-action themes use their same-file complete key maps. Their semantic
label override is limited to the reviewed fixed glyph subtrees; a child explicitly
reading that semantic token would also change. A direct inline write to the old
primitive color tokens changes precedence after migration, so that negative
control remains unaccepted. Apply a theme to the actual Button; arbitrary local
themes do not travel across portals.

A component's styles live with its implementation; area-wide repeated styles
live in its `surface.ts`. Import tokens using relative `.stylex` paths. The shared
`componentsStylexOptions` also resolves `@/style/*` in Storybook, Vitest and the
desktop renderer. The StyleX compiler evaluates `stylex.create` statically;
ordinary imported runtime constants are not compile-time token values.

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

The default marker is shared across components. Qualify an ancestor selector
with an owned data attribute, as the project row and disabled context action do,
so an unrelated outer marker cannot reveal a nested control. Verify outer hover
and focus as well as the component's own hover and focus.

## Capture and verify a batch

1. Record the remaining usage with `node scripts/tailwind-usage.mjs --json`.
   It uses the locked Tailwind compiler to validate AST-discovered candidates.
   Scanner version 2 also follows direct `element.className = …` writes,
   including literal bracket access. Version 1 omitted the iframe's five
   utilities, so its frozen inventory fell by 21 while that batch migrated 26.
   Keep historical method/count records and compare versions on the same source
   snapshot. Counts are source occurrences; unresolved dynamic/compound writes
   are reported separately and are not evidence of zero usage.
2. Capture the unchanged component before editing. Prefer a fixed Storybook
   build. Include its important states, both themes, narrow/desktop widths and
   exact breakpoint boundaries. New stories render production components with
   synthetic data, never recreated approximations of the UI.
3. Migrate one owned unit, then run its behavior suites, component typecheck,
   formatting and `node scripts/stylex-review.mjs`. The review script is an aid;
   it cannot prove CSS equivalence.
4. Capture after with the same targets and Chromium. The harness waits for
   Storybook completion, fonts, finite animations and stable geometry. Capture
   rendering failures and fail the command instead of silently omitting them.
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
pnpm exec storybook build --output-dir /tmp/lody-stylex-before
node tests/visual/serve.mjs --root /tmp/lody-stylex-before --port 6017
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
