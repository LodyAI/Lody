# Layout and text tags

## `Card`

Grouping container — one card per coherent unit. Don't wrap plain prose in a
card; use it only when content benefits from a boundary (a control group, a
result panel).

```genui
<Card>
  <Heading level={3}>Title</Heading>
  <Text>Body</Text>
</Card>
```

## `Row` / `Column`

Flex containers. `gap` is a number in px (default small). `Row` wraps and
centers items vertically. Use `<Spacer />` inside a row to push trailing items
to the end.

```genui
<Row gap={12}>
  <Icon name="info" />
  <Text>Status detail</Text>
  <Spacer />
  <Badge tone="success">Done</Badge>
</Row>
```

## `Divider`

Horizontal rule between sections. Self-closing, no props.

## `Spacer`

Expands to fill remaining space in a `Row`/`Column`. `size` sets a minimum in px.

## `Text`

Body copy. `muted` dims to secondary color. Literal text chunks are trimmed
around each `{expr}` hole. Put the whole sentence in one template literal to
preserve spaces and punctuation around dynamic values.

```genui
<Text>{`Current value: ${value}%`}</Text>
<Text muted>Secondary explanation</Text>
```

## `Heading`

`level` (1–6, default 3, clamped). Use sparingly — one heading per card section.

## `Badge`

Status pill. `tone`: `neutral` (default), `success`, `warning`, `danger`,
`running`. Badges mark real state, not decoration — don't use as a title accent.

```genui
<Badge tone={enabled ? 'running' : 'neutral'}>{enabled ? 'Live' : 'Idle'}</Badge>
```

## `Icon`

Lucide icon by kebab-case `name` (`check-circle`, `x-circle`, `info`, `sun`,
`map-pin`, …). `size` in px (default 14). Unknown names render nothing.
