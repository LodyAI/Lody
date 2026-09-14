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
| `src/disclosure`    | Tabs, Accordion and Collapsible: a trigger, and the thing it shows   |
| `src/feedback`      | Alert, Toast, Progress, Skeleton and Spinner: what the system says back |
| `src/card`          | The card rung as a component: a block of a page, and its tokens      |
| `src/badge`         | A standing fact about the thing beside it, on no rung at all         |
| `src/separator`     | The one line the rules allow: between the rows of a list or a table  |
| `src/icons`         | The icon set: one 24 grid, four treatments of each drawing, and the icons that move between two states |
| `playground`        | The icon playground: a standalone Vite page for searching, scaling, recolouring and copying the set |
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

`Tabs`, `Accordion` and `Collapsible` are one family too, and what they share is
the question rather than the shape: a trigger, and the thing it shows. A tab
strip lays the choices side by side and swaps the panel under them; an accordion
stacks them and opens one in place; a collapsible is a single one of those rows
with no list around it.

A strip is the elevation ladder read twice over — a well-rung track with one
thing raised out of it, the same pair a `Switch` takes. The pill under the
selected tab is one element that slides rather than a fill on each tab, because
the strip is one control, and `Tabs.List` draws it rather than the caller, the
way a submenu's chevron is drawn by its row.

```tsx
<Tabs.Root defaultValue="sync">
  <Tabs.List>
    <Tabs.Tab value="sync">Conversation sync</Tabs.Tab>
    <Tabs.Tab value="worktree">Worktree setup</Tabs.Tab>
  </Tabs.List>
  <Tabs.Panel value="sync">…</Tabs.Panel>
  <Tabs.Panel value="worktree">…</Tabs.Panel>
</Tabs.Root>
```

The size is stated once, on the strip: a tab's height, its corner and its share
of the width all follow from the track's. A strip that should take the width on
offer says `stretch`, which stretches the track *and* splits it between the tabs
— stating only the first would leave a full-width groove with the choices
huddled at its start. Arrow keys move between tabs without taking one, because a
tab swaps a panel that may be expensive to build; a surface whose panels are
cheap says `activateOnFocus`.

An accordion is that same family stacked. A row has no fill in any state — it is
a line of a list rather than a control on a surface — so the mark between rows is
the separator the rules give a list, and what moves when a row opens is the
chevron the part draws. One row is open at a time unless the root says
`multiple`.

```tsx
<Accordion.Root multiple defaultValue={['bundled']}>
  <Accordion.Item value="bundled">
    <Accordion.Trigger>Bundled assets</Accordion.Trigger>
    <Accordion.Panel>…</Accordion.Panel>
  </Accordion.Item>
</Accordion.Root>
```

A `Collapsible` is one of those rows with no list around it, so it takes neither
the line nor the row: its trigger is Base UI's, unstyled, because a lone
disclosure is opened by whatever the surface already had there — a card header, a
row of a table, a button that also says how many things are under it.

```tsx
<Collapsible.Root>
  <Collapsible.Trigger render={<Button variant="secondary" size="small" />}>
    3 files changed
  </Collapsible.Trigger>
  <Collapsible.Panel>…</Collapsible.Panel>
</Collapsible.Root>
```

**A revealed panel's padding goes on a child of it.** Base UI animates the
panel's height from a size it measures with `scrollHeight`, which counts
padding, so a padded panel is cropped by exactly its own padding under
`border-box` and overshoots by it under `content-box`. `Accordion.Panel` already
holds its prose in such a child; a caller migrating a panel that carried its own
padding moves it inwards.

`Alert`, `Toast`, `Progress`, `Skeleton` and `Spinner` are one family as well,
and what they share is a sentence with two halves: what happened, and that it is
not finished.

An `Alert` and a `Toast` are **one message on two rungs**. An alert stays on the
page it is about, so it takes the card rung; a toast arrives over that page, so
it takes the floating one. Neither is on the modal rung: a message does not have
to be answered.

```tsx
<Alert.Root tone="danger">
  <Alert.Title>Sync failed</Alert.Title>
  <Alert.Description>The machine did not answer in time.</Alert.Description>
  <Alert.Actions>
    <Button size="small" onClick={retry}>Retry</Button>
  </Alert.Actions>
</Alert.Root>
```

A tone — `neutral`, `success`, `warning`, `danger` — is a tint and a mark, never
a fill, and **the mark is the tone's rather than the caller's**: the point of a
tone is that a person knows what kind of message this is before reading it, and
a glyph a caller chose can put a tick on a failure. The tone also decides how
urgently a screen reader is told: a failure interrupts, a confirmation waits.

A toast is that same message, reported from anywhere:

```tsx
export const toasts = Toast.createManager();

<Toast.Provider manager={toasts} label={t('toast.region', 'Notifications')}>
  <App />
</Toast.Provider>;

toasts.add({ title: 'Sync failed', description: 'No answer.', type: 'danger' });
```

`Toast.Provider` renders the viewport itself, so a surface wraps its app once
rather than keeping a provider, a portal, a viewport and a list in step. The
viewport takes no pointer, so the page under a toast stays usable; each toast
takes it back for its own close button.

The other half is the wait. A `Progress` is a well-rung track with `accent`
running in it, because the rules give that colour to live state and name the
running indicator by name; a bar with **no value** is not a bar at zero but the
same track with a band crossing it. A bar that reports an outcome takes that
tone, and one that measures rather than progresses takes `neutral`:

```tsx
<Progress value={used} max={limit} tone={nearLimit ? 'danger' : 'running'} />
<Progress value={null} label="Indexing the worktree" />
```

A `Skeleton` takes a gray, which is what the rules reserve them for — a thing
with no role yet — and it takes its room as props rather than classes, because a
size passed as a class lands in a specificity fight with the shape's own height.
A `Spinner` is drawn in `currentColor`, so the one inside a ghost button takes
the button's ink; it is called a spinner rather than a loading, because it is the
mark and not the state, and where it goes is the surface's decision.

```tsx
<Skeleton shape="circle" width={32} height={32} />
<Skeleton width="60%" />
<Button variant="secondary" size="small">
  <Spinner size="small" label={null} />
  Saving
</Button>
```

`Table` and `Pagination` are one family too, and what they share is a list that
did not fit: the rows, and the way to the rows that are not on screen.

A table is **the one part of this package with no surface of its own** — no
background, no shadow, no radius. It is rows on whatever the surface around it
already was, so a card holding one keeps owning its edges, and the one thing it
draws is the edge the rules give a list: `separator`, between one row and the
next. The head takes that line too, because the row after it is the first
record; the last record draws none.

**A column is stated once.** That is the whole design:

```tsx
const columns: TableColumn<Session>[] = [
  { key: 'name', header: t('sessions.name'), cell: (s) => s.name, width: 220 },
  { key: 'agent', header: t('sessions.agent'), cell: (s) => s.agent },
  { key: 'turns', header: t('sessions.turns'), cell: (s) => s.turns, numeric: true, sortable: true },
];

<Table
  columns={columns}
  rows={sessions}
  rowKey={(session) => session.id}
  sort={sort}
  onSortChange={setSort}
  selected={selected}
  onSelectedChange={setSelected}
  onRowPress={(session) => open(session.id)}
  maxHeight={320}
  empty={t('sessions.none')}
/>
```

How wide a column is, which way it aligns, whether it holds figures, whether the
table can be ordered by it, what a totals row holds under it — all facts about a
*column*, and a column written twice (a name in the head, a cell in every row) is
a fact that can drift. Both surfaces in this repository that drew a table before
this wrote their column template as a literal `grid-cols-[…]` string in the
header and again in the row, by hand.

Everything else follows from having them in one place:

- **Ordering** is one column at a time, on the root rather than per column, so
  two columns wearing the arrow is a state that cannot be expressed. The arrow
  and `aria-sort` are the part's; the **rows are never reordered** — a server
  sorts, a comparator breaks ties, a page is one slice of many.
- **Selection** is a tick first. `aria-selected` belongs to a row in a grid, so
  the table puts a `Checkbox` in the row — what a person presses and what a
  screen reader is told — and derives the box over that column: none, some
  (`mixed`), or all. A selection reaching past the rows on screen survives a
  select-all.
- **`maxHeight` and a head that stays are one decision**, because a head that
  scrolls out of its own box is not something a surface would ask for. A head
  that stays is no longer a row but a band over them, so it takes the region
  rung; a transparent one has the records painted through the column names.
- **The pointer is answered only where `onRowPress` says something happens.**
  The Radix table this replaces lit every row, and its one caller had to turn
  that off with a class. A pressable row takes the keyboard with it: Enter and
  Space press it, and it rings where the keyboard is.
- **`empty` crosses every column**, including the one the boxes are in — a count
  only the table knows.

**A table too narrow for its columns becomes a list of records**, each a stack of
label-and-value lines, with the label being the head's own words. It asks about
*its own* width rather than the window's — a table in a 360px side panel on a
27-inch screen is narrow — so it is a container query, and a table whose columns
must stay a grid says `stack={false}`.

The parts are exported for a table that is **not** a list of records — a
two-column list of facts, or markup produced from a Markdown document:

```tsx
<Table.Root size="large">
  <Table.Body>
    <Table.Row>
      <Table.ColumnHeader scope="row">{t('summary.agent')}</Table.ColumnHeader>
      <Table.Cell>{agentName}</Table.Cell>
    </Table.Row>
  </Table.Body>
</Table.Root>
```

`Pagination` is one control rather than a kit of parts, because the part a caller
would otherwise assemble is the one that is easy to get wrong — which pages to
list out of nine thousand, and where to admit the rest are missing:

```tsx
<Pagination page={page} pages={pages} onPageChange={setPage} />
<Pagination layout="compact" jump page={page} pages={9214} onPageChange={setPage} />
```

The window is one width from the first page to the last, so the buttons do not
move out from under the pointer, and a gap is drawn only where it stands for more
than one page. Where the pages are too many to list, `compact` says where you are
instead — and `jump` lets a person type it, committing on Enter or on leaving the
field rather than on every keystroke, since typing 4-5 through a pager that
navigates as you type visits page 4 on the way to page 45. Every word it says is
one `labels` prop, so a surface translates all of them or none.

A `Card` is the elevation ladder's card step made a component, and its parts are
a Dialog's: what separates a panel that owns the window from a block that owns a
region of a page is the rung and the heading step, not what either is made of.
It takes the same `headline` a dialog's title does, because the rules reserve
`title` for a page that is a page.

```tsx
<Card.Root>
  <Card.Header>
    <Card.Title as="h2">Worktree setup</Card.Title>
    <Card.Description>Commands that run once, before the agent starts.</Card.Description>
  </Card.Header>
  <Input placeholder="pnpm install" />
  <Card.Footer>
    <Button variant="ghost" size="small">Reset</Button>
    <Button size="small" onClick={save}>Save</Button>
  </Card.Footer>
</Card.Root>
```

A card **does not nest**: two of them one inside the other are the same fill
twice in the light palette, where the card rung and the page are one white. A
block inside a card is the region rung, which a surface lays out. And a card
renders no control of its own — `interactive` marks it as the pressable thing
and answers the pointer with `card.hover`, while the button or the link stays
the caller's, because what a press does is a product decision.

A `Badge` is a standing fact about the thing beside it, and the one part of this
system on **no rung**: it sits on a page, a card, a menu row or a modal panel,
so it takes no background from the ladder. Its tone is a *film* of that tone
over whatever is underneath — 12% of `label` for neutral, 22% of its own colour
for the rest — **and its word carries that tone as well**, as the tone pulled
halfway to `label`.

The raw tone cannot carry it: `warning` is 2.8:1 on a near-white surface, a
colour for a 16px mark rather than for 11px text. Half the distance to the ink
keeps the hue and gains the contrast — 5.2:1 at the worst, on every rung in both
palettes — and the word is the mark a person actually looks at on a 20px chip.
The four words land 0.097 apart in oklab at the closest in the light palette and
0.048 in the dark, against 0.030 and 0.035 for the films under them. In the dark
palette that is the whole difference: `accent` is a pale peach there and
`warning` an amber, so their films are two brown washes and their words are a
peach and a gold.

A neutral badge has no tone to carry, so its word is `label` — which is also the
ink the other four are pulled toward, and not `secondaryLabel`: the word sits on
the film rather than on the page, where `secondaryLabel` measured 3.4:1.

```tsx
<Badge>Plus</Badge>
<Badge tone="running">Opening Lody Desktop…</Badge>
<Badge tone="danger">Failed</Badge>
<Badge icon={<Laptop className="h-3 w-3" />}>macOS</Badge>
```

The tones are the four a message reports plus `running`, which `Progress` adds
for the same reason: something being reached is live state, which is what
`accent` is for. There is no hover, no focus ring and no filled variant — a chip
a person can press is a `Button`. The leading box is the caller's glyph, the way
a menu row's is, and a badge neither grows nor shrinks: a surface that must cap a
long one caps the badge itself, since a chip that shrank would be clipped by a
tight row rather than by a decision.

A `Separator` is the one line the rules allow: between the rows of a list or a
table, never around a surface — that is a shadow — and never under a header,
which is a gap. It is announced rather than hidden, because a line here is never
decoration, and it carries no margin of its own: where it sits in a stack is the
surface's layout.

```tsx
<Separator />
<Separator orientation="vertical" />
```

An `Avatar` is who this is: a picture, or the letters standing in for one. It
is the second part here on no rung and the one that is not a film — what it
stands in for is opaque, so the fallback takes a **gray**, which is what the
rules reserve the gray ramp for: a thing with no role.

```tsx
<Avatar.Root size="small">
  <Avatar.Image src={user.image} alt={user.name} />
  <Avatar.Fallback>ZX</Avatar.Fallback>
</Avatar.Root>

<Avatar.Root size="large" shape="tile">
  <Avatar.Fallback style={{ backgroundColor: hueFor(workspace.name) }}>L</Avatar.Fallback>
</Avatar.Root>
```

Five rungs — 16, 20, 24, 32 and 64 — and **the rung picks the letters**. That is
the whole reason the size is a prop: the deleted implementation had one size,
and each of its twenty call sites stated the box and the type step separately
(`h-5 w-5 text-[9px]`, `h-7 w-7 text-[11px]`, `h-16 w-16 text-xl`), which is two
facts a surface had to keep in step and eight different answers about what two
letters in a circle means. Two initials want `small` or larger: at `mini` a
circle is a face where an icon would otherwise be, and a picture or a mark is
the better answer — two capitals fit it only just. Which of the image and the fallback is on
screen is Base UI's, read from the image's own loading status, so a surface
writes both and never writes the condition.

A person is a `circle`, a thing is a `tile`: a circle around a logo is a crop,
and the mark inside one was drawn square. The tile's corner follows the rung
from the radius-by-size table rather than a token of its own. A surface with an
identity colour for the thing — a hue derived from a workspace name, so the same
workspace is the same colour everywhere — passes it as a `style`, because which
hue belongs to which name is a product fact and not a token.

A `Kbd` is a key on the keyboard, and a `KbdGroup` is the chord it is pressed
in.

```tsx
<Kbd>esc</Kbd>
<KbdGroup>
  <Kbd>⌘</Kbd>
  <Kbd>K</Kbd>
</KbdGroup>
```

It is a gray for the same reason: a cap stands for a piece of hardware rather
than for anything on the screen. It is never a control — no hover, no focus
ring, no pressed state — and it is not a menu row's shortcut, which the rules
give plain trailing metadata instead, because a column of chips down a menu's
right edge turns a quiet list into a keyboard diagram. A cap is for the surfaces
where the keys are the subject: a command palette, a shortcuts sheet, a tooltip
that teaches one.

A cap standing on a `Tooltip` inverts with it. `Tooltip.Content` declares
`kbdOnInvertedTheme` on its popup, and every cap under it inherits — a component
token group is how a surface tells what is inside it what it is standing on, and
unlike the descendant selector the deleted implementation used it also reaches a
cap a caller wrapped in something of their own.

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
[UI overlay primitives note](../../.agents/notes/implemented/feature/2026-09-12-ui-overlay-primitives.md);
the table with no surface, the pager that shares its group, and the two Radix
files they replace are recorded in the
[UI table and pagination note](../../.agents/notes/implemented/feature/2026-09-12-ui-table-pagination.md);
the card rung as a component, the badge that is on no rung, and the one line the
rules allow are recorded in the
[UI card, badge and separator note](../../.agents/notes/implemented/feature/2026-09-12-ui-card-badge-separator.md);
the avatar ladder that picks its own letters, the key cap, and the token group
that carries an inversion across a surface are recorded in the
[UI avatar and kbd note](../../.agents/notes/implemented/feature/2026-09-13-ui-avatar-kbd.md).

Open the gallery with `pnpm storybook` and pick _Design System / UI Gallery_.
It renders each sample once per palette and reads its values back off the
rendered nodes, so a token that changes shows its new value there without the
board being edited. A new token or primitive state lands with its board entry;
`test/gallery.test.tsx` fails when a token has no entry.

The icon set has a page of its own instead, because the board answers the wrong
question about it: a token has one value to show, and an icon has 75 drawings
you need to search, size, recolour and take away. Run
`pnpm --filter @lody/ui playground` and open the printed URL. It is a Vite
server over `packages/ui/playground` with no Storybook under it: search the set,
scale it from 12 to 64, switch the four treatments, recolour it through the
semantic tones, and stand it on the page, raised, well and accent rungs — the
accent rung is where you see that a glyph cuts a hole through a mask rather than
painting its marks the panel's colour. Press an icon for its panel: the drawing
enlarged on the 24 grid, every size at once, the import line, and `copy svg` for
the markup a caller would paste. The stateful icons are at the bottom; press one
to flip it, and turn on _slow motion_ to watch `--lody-icon-t` interpolate
rather than infer it from the two ends. `playground:build` writes the same page
to `playground/dist` when it has to be looked at somewhere else.

Run `pnpm --filter @lody/ui typecheck` and `pnpm --filter @lody/ui test` after
changing a primitive or token.
