# `@lody/ui`

`@lody/ui` contains Lody's low-level visual primitives and semantic StyleX
tokens. Product surfaces compose these primitives through
`@lody/components`; the package does not contain product workflows or platform
behavior.

| Area                | Responsibility                                                      |
| ------------------- | ------------------------------------------------------------------- |
| `src/tokens`        | Semantic color, type, spacing, motion, radius, and elevation tokens |
| `src/theme`         | Applies light or dark StyleX themes to a subtree                    |
| `src/button`        | Base UI Button behavior and Lody variants, sizes, tones, and shapes |
| `src/field`         | Base UI Field composition: label, Input, Textarea, Checkbox, Radio, Switch, Select, Combobox, help, and error |
| `src/popup`         | The floating surface a list, a menu or a popover opens on, and its tokens |
| `src/menu`          | Menu, ContextMenu and Menubar: commands on that surface             |
| `src/popover`       | The same surface holding content rather than rows                   |
| `src/dialog`        | Dialog and AlertDialog: the modal rung, and its tokens               |
| `src/drawer`        | The same rung, arriving from an edge and draggable back out          |
| `src/tooltip`       | The inverted chip that names what is under the pointer               |
| `src/gallery`       | The token board: every token and primitive state, in both palettes  |
| `stylex-options.ts` | Shared compiler configuration for source-consuming hosts            |

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
</Field.Root>
```

`Combobox` is the same list with a query in front of it. On its own the input is
the whole control; inside a `Combobox.InputGroup` the group is the well and the
input is bare, so a chevron beside it lands inside one control rather than beside
a second one.

A `Menu` is that same floating surface with commands on it. It is also the
dropdown menu: Base UI has no separate part for one, so a second name would be a
second thing to keep in step. A menu is opened by whatever the surface already
had there, through Base UI's `render`:

```tsx
<Menu.Root>
  <Menu.Trigger render={<Button variant="ghost" icon aria-label="Session actions" />}>
    <MoreIcon />
  </Menu.Trigger>
  <Menu.Content>
    <Menu.Item shortcut="⌘R" onClick={rename}>Rename</Menu.Item>
    <Menu.Submenu>
      <Menu.SubmenuTrigger inset>Export</Menu.SubmenuTrigger>
      <Menu.Content>
        <Menu.Item onClick={exportPdf}>PDF</Menu.Item>
      </Menu.Content>
    </Menu.Submenu>
    <Menu.Separator />
    <Menu.Item tone="destructive" onClick={remove}>Delete</Menu.Item>
  </Menu.Content>
</Menu.Root>
```

`ContextMenu` and `Menubar` restate only the way in — a right click or a long
press, and a bar of names — and re-export `Menu`'s rows rather than rebuilding
them, so a command looks and behaves the same wherever a person meets it. A row
answers `onClick`; a row that should leave the menu up says `closeOnClick={false}`
rather than cancelling the event. Where focus goes after a menu closes is the
product's policy, passed as `finalFocus`.

A row's leading box holds a caller's icon, a tick or a dot, and sizes what is in
it: a glyph placed there states its own dimensions as 100% rather than arriving
at its icon library's default, because this package has no descendant selector to
reach it with. A row with no icon takes no box, so an icon-less menu is not
indented for nothing; a row in a mixed list asks for one with `inset`.

A `Popover` is that same floating surface holding content instead of rows. It
reads the popup group too, and replaces five of a list's declarations: the width
a list takes from the control that shows its value, the 4px inset that lets a row
bleed to the surface's edge, and the three that make the type a control's rather
than prose.

```tsx
<Popover.Root>
  <Popover.Trigger render={<Button variant="secondary" />}>Filter</Popover.Trigger>
  <Popover.Content>
    <Popover.Header>
      <Popover.Title>Filter sessions</Popover.Title>
      <Popover.Description>Applies to the list under it.</Popover.Description>
    </Popover.Header>
    <Field.Root>
      <Field.Label>Name contains</Field.Label>
      <Input size="small" />
    </Field.Root>
    <Popover.Close render={<Button size="small" />}>Apply</Popover.Close>
  </Popover.Content>
</Popover.Root>
```

`Dialog`, `AlertDialog` and `Drawer` are one family on the modal rung — the
elevated background under the large shadow, over an overlay. They share one token
group and one surface, and differ only in how they arrive and in what may dismiss
them. A dialog carries a cross and says so; an alert dialog is answered rather
than dismissed, so a press beside it is not an answer, though Escape still is.

```tsx
<Dialog.Root>
  <Dialog.Trigger render={<Button variant="secondary" />}>Rename</Dialog.Trigger>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Rename session</Dialog.Title>
      <Dialog.Description>The name shows in the sidebar.</Dialog.Description>
    </Dialog.Header>
    <Input placeholder="Describe the task" />
    <Dialog.Footer>
      <Dialog.Close render={<Button variant="secondary" />}>Cancel</Dialog.Close>
      <Dialog.Close render={<Button onClick={save} />}>Save</Dialog.Close>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
```

An alert dialog's answers are Buttons rather than parts of the component: which
variant an answer takes is the surface's decision, so a footer writes them with
`AlertDialog.Close render={<Button variant="destructive" />}`.

A `Drawer` is that same panel arriving from an edge — and there is deliberately no
`Sheet`. A panel that slides in from an edge promises that it can be sent back,
and on a touch screen a person will try; a dialog pinned to an edge cannot answer
that gesture. Base UI's Drawer lays the panel out inside a viewport instead of
positioning it, which is what leaves the panel's own `transform` free to follow a
finger.

```tsx
<Drawer.Root side="bottom">
  <Drawer.Trigger render={<Button variant="secondary" />}>Filters</Drawer.Trigger>
  <Drawer.Content side="bottom">
    <Drawer.Header>
      <Drawer.Title>Filters</Drawer.Title>
      <Drawer.Description>They apply to the session list.</Drawer.Description>
    </Drawer.Header>
    <Field.Label>
      <Checkbox name="running" defaultChecked />
      Running only
    </Field.Label>
  </Drawer.Content>
</Drawer.Root>
```

`side` is the writing direction's edge — `top`, `bottom`, `start`, `end` — and the
root derives the physical swipe from it, so a drawer on the start edge is swiped
away leftwards in a left-to-right document and rightwards in a right-to-left one.
The edge is stated on both parts because the root needs it for the gesture and the
content for the layout. `inset` is the second axis: a flush drawer meets the
window and squares the two corners that touch it, while an inset one floats at
`dialog.drawerInset` and keeps all four.

A shell that wants the page to recede behind an open drawer wraps its own UI in
`Drawer.Indent` and styles `data-active` itself; that is a decision about a
product's shell rather than about a drawer, so the primitive exposes it and does
not choose.

A popup mounts on the document by default, and a modal panel is the exception. A
surface that owns a focus scope and a scroll lock states its panel once with
`PopupContainerProvider`, and every Select, Combobox, Menu and Popover under it
mounts inside the panel instead of being treated as outside it. `Dialog.Content`,
`AlertDialog.Content` and `Sheet.Content` do this for their own panel, so a
product surface never has to.

A `Tooltip` is the one floating part that does not read the popup group. The
elevation ladder puts a menu, a popover and a list on the raised background under
the popover shadow, and names the tooltip apart: `label` with `shadow.medium`, an
inversion, because a tooltip is not a place to act but a label over one.

```tsx
<Tooltip.Provider>
  <Tooltip.Root>
    <Tooltip.Trigger render={<Button variant="ghost" icon aria-label="Rerun" />}>
      <RerunIcon />
    </Tooltip.Trigger>
    <Tooltip.Content>Rerun this turn</Tooltip.Content>
  </Tooltip.Root>
</Tooltip.Provider>
```

A tooltip is visual only. Base UI gives the chip no role and wires no
`aria-describedby`, because a tooltip is reachable by neither touch nor a screen
reader, so **the trigger states its own `aria-label`** — a control whose only name
was its tooltip has no name at all. `Tooltip.Provider` groups them, so once one
has opened the next opens without its delay.

The state mapping every control in this family shares — rest, placeholder,
focus, invalid, disabled, checked, selected — is in
[token rules](src/tokens/RULES.md#fields).

The intended behavior is specified in [Shared UI primitives](../../specs/ui-primitives.md).
The integration decision is recorded in the
[UI Button migration takeover note](../../.agents/notes/implemented/architecture/2026-09-08-ui-button-migration-takeover.md);
the field family and the Tailwind field concepts it replaces are recorded in the
[UI field primitives note](../../.agents/notes/implemented/feature/2026-09-09-ui-field-primitives.md);
the menu family and the migration still owed to it are recorded in the
[UI menu primitives note](../../.agents/notes/implemented/feature/2026-09-11-ui-menu-primitives.md);
the popover, the modal rung, the tooltip and the migration still owed to them are
recorded in the
[UI overlay primitives note](../../.agents/notes/implemented/feature/2026-09-12-ui-overlay-primitives.md).

Open the gallery with `pnpm storybook` and pick _Design System / UI Gallery_.
It renders each sample once per palette and reads its values back off the
rendered nodes, so a token that changes shows its new value there without the
board being edited. A new token or primitive state lands with its board entry;
`test/gallery.test.tsx` fails when a token has no entry.

Run `pnpm --filter @lody/ui typecheck` and `pnpm --filter @lody/ui test` after
changing a primitive or token.
