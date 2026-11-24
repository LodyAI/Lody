# Layout and text tags

## `card`

Grouping container — one card per coherent unit. Don't wrap plain prose in a
card; use it only when content benefits from a boundary (a control group, a
result panel).

```genui
<card>
  <heading level={3}>Title</heading>
  <text>Body</text>
</card>
```

## `row` / `column`

Flex containers. `gap` is a number in px (default small). `row` wraps and
centers items vertically. Use `<spacer />` inside a row to push trailing items
to the end.

```genui
<row gap={12}>
  <icon name="info" />
  <text>Status detail</text>
  <spacer />
  <badge tone="success">Done</badge>
</row>
```

## `divider`

Horizontal rule between sections. Self-closing, no props.

## `spacer`

Expands to fill remaining space in a `row`/`column`. `size` sets a minimum in px.

## `text`

Body copy. `muted` dims to secondary color. Literal text between tags renders
as-is; dynamic content goes in `{expr}`:

```genui
<text>Current value: {value}%</text>
<text muted>Secondary explanation</text>
```

## `heading`

`level` (1–6, default 3, clamped). Use sparingly — one heading per card section.

## `badge`

Status pill. `tone`: `neutral` (default), `success`, `warning`, `danger`,
`running`. Badges mark real state, not decoration — don't use as a title accent.

```genui
<badge tone={enabled ? 'running' : 'neutral'}>{enabled ? 'Live' : 'Idle'}</badge>
```

## `icon`

Lucide icon by kebab-case `name` (`check-circle`, `x-circle`, `info`, `sun`,
`map-pin`, …). `size` in px (default 14). Unknown names render nothing.
