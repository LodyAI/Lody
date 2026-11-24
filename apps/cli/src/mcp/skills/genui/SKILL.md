---
name: genui
description: Author `genui` fenced blocks — declarative, stateful, interactive UI inside chat answers — or inline catalog tags in ordinary markdown. Use when a reply benefits from controls (sliders, switches, selects, buttons) instead of static text. Read a reference file only for the component families you actually use.
---

# GenUI surface authoring

Use ordinary Markdown for prose, lists, and tables. Embed a static `Icon` or
`Badge` directly in that Markdown. Use a fenced `genui` block for cards, other
catalog layouts, controls, and values that depend on state. Put every control
and display that shares state in the same fence, even across several cards.

Use a `<Card>` wrapper when the request calls for a card, with its
`<Column>` or `<Row>` inside. Preserve requested state slot names, exact
button labels, and specified display text.

Start the fence with the `{@state}` directives, then write JSX-like markup.
A fence mounts while it streams. Each element appears when its open tag
closes, so declare state before any markup that reads it.

```genui
{@state const [tickets, setTickets] = useState(0)}
<Card>
  <Column gap={8}>
    <Heading>Tickets</Heading>
    <Text>{tickets}</Text>
    <Badge>{`Reserved: ${tickets}`}</Badge>
    <Button onClick={() => {
      setTickets(prev => prev + 1);
      setTickets(prev => prev + 1);
    }}>Reserve two tickets</Button>
  </Column>
</Card>
```

## Rules that are enforced, not conventions

- `{@state const [x, setX] = useState(<expr>)}` is the *only* way to declare state.
  It must appear before the markup, never inside it. `x` is read in expressions;
  `setX(next)` or `setX((prev) => next)` writes it. Re-declared slots keep their
  committed value across revisions — `useState` is a *default*, not a reset.
  Each functional setter reads the latest committed value, including writes
  earlier in the same callback.
- `{expr}` in markup is an *expression hole*: no `const`, `if`, or statements.
  Event props take JS callbacks: `onChange={(v) => setV(v)}`, `onClick={() => …}`.
- The evaluator is confined: literals, arithmetic, ternaries, template strings,
  arrow functions, array methods (`map/filter/find/reduce/sort/…`), calls into
  state setters and `lody.*` capabilities. No `window`/`fetch`/`import`/globals.
- Every tag must be in the catalog below — an unknown tag renders as an
  inline `<tag>` placeholder plus a diagnostic, never a crash.
- Adjacent literal text is trimmed at expression boundaries. Put the full
  label in one template literal to preserve spaces in `Text` and `Badge`.
  For a standalone value, use just `<Text>{value}</Text>`.
- A slider's `onChange` sends a number. Keep text input values and
  `onValueChange` state as strings, and convert at the point of calculation
  with `Number(value)`. Write array totals as
  `items.reduce((sum, item) => sum + item, 0)`.

## Inline catalog tags (no fence)

Leaf, presentational tags also work inside ordinary markdown — sentences,
table cells, list items — with literal props only:

```markdown
| 检查项    | #2620                                        |
| --------- | -------------------------------------------- |
| CLI tests | <Icon name="x-circle" color="danger" /> 失败 |

服务在线 <Badge tone="success">running</Badge>，一个仍在启动 <Badge tone="warning">pending</Badge>。
```

- Write a self-closing `<Icon ... />` or a pair
  `<Badge tone="warning">Pending</Badge>` directly in Markdown. Backticks show
  the source as code.
- Use quoted literal prop values and a plain-text badge label. Escape Markdown
  punctuation that should be visible, for example
  `<Badge tone="warning">\*Pending\*</Badge>` for the label `*Pending*`.
  Markup inside the label prevents the badge pair from rendering.
- Inline tags have no state or callbacks. Braces in a badge label are literal
  characters. Use a fenced badge for a dynamic label or tone.
- Inline `Icon` takes quoted `name` and optional `color`
  (danger/success/warning/accent). It renders at 14 px. Use a fenced icon with
  `size={20}` for a custom size. The legacy `inline` prop has no effect.

## Catalog index

Props that matter per tag; full prop tables and per-family examples live in
`references/` — read a family file only when you use it.

| Tag | Purpose | Key props |
|---|---|---|
| `Card` | Grouped container | — |
| `Row` / `Column` | Flex row / column | `gap` (px) |
| `Divider` | Horizontal rule | — |
| `Spacer` | Pushes siblings apart | `size` |
| `Text` | Body text | `muted` |
| `Heading` | h1–h6 | `level` (default 3) |
| `Badge` | Status pill | `tone`: neutral/success/warning/danger/running |
| `Icon` | Lucide icon | `name` (kebab-case), `size` |
| `Button` | Action | `onClick`, `variant`, `size`, `disabled` |
| `Input` | Text field | `value`, `onValueChange(v)`, `placeholder`, `disabled` |
| `Checkbox` / `Switch` | Boolean toggle | `checked`, `onCheckedChange(v)`, `disabled` |
| `Select` | Dropdown | `items`, `value`, `onValueChange(v)`, `placeholder` |
| `Slider` | Numeric range | `value`, `min`, `max`, `step`, `disabled`, `onChange(n)` |
| `svg` family | Custom diagrams | `viewBox`; `rect` `circle` `ellipse` `line` `polyline` `polygon` `path` `g`; labels via `svg:text` |

## References (read on demand)

- [expressions](references/expressions.md) — confined-JS subset, state semantics, `lody.*` capabilities, error shapes.
- [layout-text](references/layout-text.md) — Card, Row, Column, Divider, Spacer, Text, Heading, Badge, Icon: props, examples, misuse patterns.
- [controls](references/controls.md) — Button, Input, Checkbox, Switch, Select, Slider: props, event contracts, worked examples.
- [svg](references/svg.md) — svg, shapes, svg:text: the confined diagram subset, paint attributes, examples.

## Validate before shipping

A surface that fails to compile degrades to its own fenced code block in chat —
readers never see diagnostics, so write markup as if errors were invisible. When
editing the runtime or catalog, the ground truth is `packages/genui` (parser +
evaluator) and `packages/components/src/components/ai-gui/genui/` (catalog
renderers); run `pnpm --filter @lody/genui test` to check a surface end-to-end.
