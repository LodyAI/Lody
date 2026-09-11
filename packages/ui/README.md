# `@lody/ui`

`@lody/ui` contains Lody's low-level visual primitives and semantic StyleX
tokens. Product surfaces compose these primitives through
`@lody/components`; the package does not contain product workflows or platform
behavior.

| Area                | Responsibility                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/tokens`        | Semantic color, type, spacing, motion, radius, and elevation tokens                                           |
| `src/theme`         | Applies light or dark StyleX themes to a subtree                                                              |
| `src/button`        | Base UI Button behavior and Lody variants, sizes, tones, and shapes                                           |
| `src/field`         | Base UI Field composition: label, Input, Textarea, Checkbox, Radio, Switch, Select, Combobox, help, and error |
| `src/popup`         | The floating list a Select or Combobox opens, and its tokens                                                  |
| `src/gallery`       | The token board: every token and primitive state, in both palettes                                            |
| `stylex-options.ts` | Shared compiler configuration for source-consuming hosts                                                      |

Consumers compile this package's source with `@stylexjs/unplugin` and its exported
StyleX options. Visual choices use component props. `className` is available for
layout and interaction constraints in product surfaces; it must not duplicate a
primitive's visual rules.

A field is a composition rather than one component: `Field.Root` owns the name,
the disabled flag and validity, and `Field.Label`, `Input`, `Textarea`,
`Checkbox`, `Radio`, `Switch`, `Field.Description` and `Field.Error` read that
state from it.

```tsx
<Field.Root name="title" invalid={!title}>
  <Field.Label>Session title</Field.Label>
  <Input placeholder="Describe the task" />
  <Field.Description>Shown in the sidebar.</Field.Description>
  <Field.Error match>Enter a title.</Field.Error>
</Field.Root>
```

`Checkbox`, `Radio` and `Switch` are the same well as a box: off is the well
rung, on is ink. Each renders a real `<button>` with Base UI's hidden input
beside it, so a `<label>` points at it and the family's `:disabled` and
`:focus-visible` rules reach it without a second mechanism.

```tsx
<Field.Label>
  <Checkbox name="notify" defaultChecked />
  Notify me when the session finishes
</Field.Label>
```

A `Select` is a well-rung trigger plus a floating list. `Select.Content`
assembles Base UI's portal, positioner, popup, list and scroll arrows, so a
caller writes rows. `Select.Value` resolves the text it shows from `items` on
the root rather than from the rows, so a list whose row text differs from its
value is stated there too:

```tsx
const themes = [
  { value: 'system', label: 'Follow the system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

<Field.Root name="theme">
  <Field.Label>Theme</Field.Label>
  <Select.Root items={themes} value={theme} onValueChange={(next) => next && setTheme(next)}>
    <Select.Trigger>
      <Select.Value placeholder="Pick a theme" />
    </Select.Trigger>
    <Select.Content>
      {themes.map((item) => (
        <Select.Item key={item.value} value={item.value}>
          {item.label}
        </Select.Item>
      ))}
    </Select.Content>
  </Select.Root>
</Field.Root>;
```

`Combobox` is the same list with a query in front of it. On its own the input is
the whole control; inside a `Combobox.InputGroup` the group is the well and the
input is bare, so a chevron beside it lands inside one control rather than beside
a second one.

A popup mounts on the document by default. A surface that owns a focus scope and
a scroll lock — a modal — states its panel once with `PopupContainerProvider`,
and every Select and Combobox under it mounts inside the panel instead of being
treated as outside it. `@lody/components`' `DialogContent` already does this.

The state mapping every control in this family shares — rest, placeholder,
focus, invalid, disabled, checked, selected — is in
[token rules](src/tokens/RULES.md#fields). Semantic colours are referenced
directly from component styles; component token groups hold dimensions rather
than relaying colour variables through a second theme layer. Normal text is
checked at 4.5:1 and required non-text indicators at 3:1 across both palettes.

The intended behavior is specified in [Shared UI primitives](../../specs/ui-primitives.md).
The integration decision is recorded in the
[UI Button migration takeover note](../../.agents/notes/implemented/architecture/2026-09-08-ui-button-migration-takeover.md);
the field family and the Tailwind field concepts it replaces are recorded in the
[UI field primitives note](../../.agents/notes/implemented/feature/2026-09-09-ui-field-primitives.md).
The semantic colour contrast guarantees and removal of component colour relays
are recorded in the
[UI semantic colour contracts note](../../.agents/notes/implemented/architecture/2026-09-11-ui-semantic-color-contracts.md).

Open the gallery with `pnpm storybook` and pick _Design System / UI Gallery_.
It renders each sample once per palette and reads its values back off the
rendered nodes, so a token that changes shows its new value there without the
board being edited. A new token or primitive state lands with its board entry;
`test/gallery.test.tsx` fails when a token has no entry.

Run `pnpm --filter @lody/ui typecheck` and `pnpm --filter @lody/ui test` after
changing a primitive or token.
