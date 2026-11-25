---
name: genui
description: Author `genui` fenced blocks — declarative, stateful, interactive UI inside chat answers — or inline catalog tags in ordinary markdown. Reach for it whenever the reply benefits from controls (sliders, switches, selects, buttons), status chips, or a drawn figure — wireframes, UI mock-ups, layout and architecture schematics render as clean greyscale `Mock` diagrams, far better than ASCII art. Use it when the user asks to draw, sketch, diagram, mock up, or visualise anything. Read a reference file only for the component families you actually use.
---

# GenUI surface authoring

Default to ordinary Markdown prose. Reach for genui only when it materially
reduces the reader's scan cost:

- Inline `Icon` / `Badge` — real status inside a sentence or table cell, one per
  distinct status.
- Fenced `genui` + `Card` — a bounded panel grouping controls or side-by-side
  options. Never wrap plain prose in a card.
- Interactive controls — only when the reader can act on the UI itself. For
  static data a markdown table is usually clearer.
- `Mock` — **the default for any wireframe, UI mock-up, layout or architecture
  schematic.** Nest `Mock:Col`/`Mock:Row` (split space), `Mock:Cell` (a labelled
  or blank block), `Mock:Box` (a block centred on `label`/`sub`/`hint`) and the renderer computes
  every coordinate — you never write x/y/w/h and it always comes out aligned.
  Do not hand-place `svg` rects for a layout; `svg` is only for shapes `Mock`
  cannot express (icons, annotations). Node→edge graphs → ```` ```mermaid ````.
  Containers hold the leaves directly — a `Mock:Box` or `Mock:Cell` is already
  a region; wrap it in another `Mock:Col`/`Mock:Row` only to nest a further
  split. `tone` is a 5-step grey ramp deep→faint; `Cell` takes one `label`,
  `Box` up to three (`label`/`sub`/`hint`, dropped when the block is too short).

  ```genui
  <Mock w={160} h={132}>
    <Mock:Col>
      <Mock:Cell h={15} tone="mid"/>
      <Mock:Row>
        <Mock:Cell w={33} tone="band"/>
        <Mock:Box tone="faint" label="Webview" sub="Own UI" hint="postMessage"/>
      </Mock:Row>
    </Mock:Col>
  </Mock>
  ```

## Fence rules

A `genui` fence is `{@state}` directives then JSX-like markup. Declare state
before any markup that reads it — elements mount as their open tag closes.

```genui
{@state const [tickets, setTickets] = useState(0)}
<Card>
  <Column gap={8}>
    <Heading>Tickets</Heading>
    <Badge>{`Reserved: ${tickets}`}</Badge>
    <Button onClick={() => setTickets(n => n + 1)}>Reserve</Button>
  </Column>
</Card>
```

## Enforced rules

- `{@state const [x, setX] = useState(<expr>)}` is the only state declaration —
  before markup, never inside. `setX(next)` / `setX(prev => next)` writes it.
- `{expr}` is an expression hole: no `const`, `if`, or statements. Event props
  take callbacks: `onChange={(v) => setV(v)}`.
- The evaluator is confined — literals, arithmetic, ternaries, template strings,
  arrow fns, array methods, state setters, `lody.*`. No `window`/`fetch`/`import`.
- Only catalog tags render — an unknown tag shows as a `<tag>` placeholder.
- Text is trimmed at expression boundaries: put the full label in one template
  literal (`<Badge>{`Reserved: ${n}`}</Badge>`).

## Common mistakes

- `<strong>`/`<em>` inside `Text`/`Badge` — unknown tags; use a template literal.
- `Badge` for emphasis — it marks real state only, one per status.
- Prose inside `Card`, markup inside an inline `Badge` label — both break.
- Hand-placed `svg` rects for a window/panel layout — use `Mock` so the
  renderer computes coordinates; `svg` is for shapes `Mock` cannot express.

## Inline tags (no fence)

Leaf presentational tags work inside ordinary markdown with literal props:

```markdown
服务在线 <Badge tone="success">running</Badge>，仍在启动 <Badge tone="warning">pending</Badge>。
```

Self-closing `<Icon name="check" color="success" />` or a `<Badge>` pair; literal
props only, no state or callbacks. Escape markdown punctuation inside a label
(`\*Pending\*`). `Icon` takes `name` + `color` (danger/success/warning/accent),
renders at 14px.

## Catalog index

| Tag | Purpose | Key props |
|---|---|---|
| `Card` | Grouped container | — |
| `Row` / `Column` | Flex row / column | `gap` |
| `Divider` | Horizontal rule | — |
| `Spacer` | Push siblings apart | `size` |
| `Text` | Body text | `muted`, `size` |
| `Heading` | h1–h6 | `level` |
| `Badge` | Status pill | `tone`: neutral/success/warning/danger/running |
| `Icon` | Lucide icon | `name` (kebab), `size` |
| `Button` | Action | `onClick`, `variant`, `size`, `disabled` |
| `Input` | Text field | `value`, `onValueChange(v)`, `placeholder`, `disabled` |
| `Checkbox`/`Switch` | Toggle | `checked`, `onCheckedChange(v)`, `disabled` |
| `Select` | Dropdown | `items`, `value`, `onValueChange(v)`, `placeholder` |
| `Slider` | Range | `value`, `min`, `max`, `step`, `onChange(n)` |
| `Mock` | Wireframe → greyscale svg | `w`, `h`, `pad`; `Mock:Col`/`Mock:Row`/`Mock:Cell`/`Mock:Box` |
| `svg` | Vector shapes | `viewBox`; `rect` `circle` `ellipse` `line` `polyline` `polygon` `path` `g`; `svg:text` |

## References (read on demand, only for families you use)

- [expressions](references/expressions.md) — confined JS, state semantics, `lody.*`.
- [layout-text](references/layout-text.md) — Card, Row, Column, Divider, Spacer, Text, Heading, Badge, Icon.
- [controls](references/controls.md) — Button, Input, Checkbox, Switch, Select, Slider.
- [svg](references/svg.md) — svg shapes, `svg:text`, `Mock` wireframes.

## Validate

A surface that fails to compile degrades to its fenced code block — write markup
as if errors were invisible. Ground truth: `packages/genui` (parser/evaluator),
`packages/components/src/components/ai-gui/genui/` (catalog).
