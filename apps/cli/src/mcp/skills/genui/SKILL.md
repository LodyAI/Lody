---
name: genui
description: Author `genui` fenced blocks — declarative, stateful, interactive UI inside chat answers — or inline catalog tags in ordinary markdown. Use when a reply benefits from controls (sliders, switches, selects, buttons) or status chips instead of static text, or when a summary of instances, test results, release blockers, or options would be clearer with visual status markers. Read a reference file only for the component families you actually use.
---

# GenUI surface authoring

## Choosing the form

Default to ordinary Markdown prose. Reach for genui only when it materially
reduces the reader's scan cost:

- **Inline `Icon` / `Badge`** — status words inside sentences or table cells.
  Use for real state (running/degraded/pending), not decoration. Keep it
  sparing: one badge per distinct status, not one per word.
- **Fenced `genui` + `Card`** — when the reader needs a bounded panel that
  groups related controls or side-by-side option comparisons. Never wrap
  plain prose in a card.
- **Interactive controls** — only when the reader can act on the UI itself
  (a slider to preview a value, a button to trigger the next step). For
  static data, plain markdown tables are usually clearer.
- **`Mock` wireframes** — architecture/layout schematics where a labelled
  greyscale block diagram beats a paragraph. Describe the nesting
  (`Mock:Col`/`Mock:Row` split space; `Mock:Box` centres `label`/`sub`/`hint`)
  and the renderer computes every coordinate — never write x/y/w/h.
  For node→edge graphs and state machines, a ```` ```mermaid ```` fenced block
  in ordinary Markdown renders the diagram; for hand-tuned vector scenes,
  `svg` + `svg:text`.

A single reply often mixes all three: lead with prose, drop inline badges
where status matters, add a fenced card only for the part that benefits from
a bounded comparison or interaction.

## Fence rules

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

## Common mistakes

- `<strong>` / `<em>` / `<b>` / `<i>` inside `Text` or `Badge` — unknown tags
  render as literal `<strong>` text plus a diagnostic. Use a template literal
  or `Heading` instead.
- Multiple `Badge` tags in one sentence for emphasis. Badges mark real state,
  not decoration.
- Wrapping prose paragraphs in `Card`. Cards are for bounded control groups
  or comparisons only.
- Nesting markup inside an inline `Badge` label — it prevents the pair from
  rendering. Escape Markdown punctuation instead.

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
| `Mock` | Declarative nested-layout wireframe → greyscale svg | `w`, `h`, `pad`; children `Mock:Col`/`Mock:Row`/`Mock:Cell`/`Mock:Box` |
| `svg` family | Hand-placed vector shapes | `viewBox`; `rect` `circle` `ellipse` `line` `polyline` `polygon` `path` `g`; labels via `svg:text` |

## References (read on demand)

- [expressions](references/expressions.md) — confined-JS subset, state semantics, `lody.*` capabilities, error shapes.
- [layout-text](references/layout-text.md) — Card, Row, Column, Divider, Spacer, Text, Heading, Badge, Icon: props, examples, misuse patterns.
- [controls](references/controls.md) — Button, Input, Checkbox, Switch, Select, Slider: props, event contracts, worked examples.
- [svg](references/svg.md) — svg, shapes, svg:text, `Mock` wireframes: the confined vector subset, paint attributes, examples.

## Validate before shipping

A surface that fails to compile degrades to its own fenced code block in chat —
readers never see diagnostics, so write markup as if errors were invisible. When
editing the runtime or catalog, the ground truth is `packages/genui` (parser +
evaluator) and `packages/components/src/components/ai-gui/genui/` (catalog
renderers); run `pnpm --filter @lody/genui test` to check a surface end-to-end.
