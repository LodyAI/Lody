---
name: genui
description: Author `genui` fenced blocks — declarative, stateful, interactive UI inside chat answers — or inline catalog tags in ordinary markdown. Use when a reply benefits from controls (sliders, switches, selects, buttons) instead of static text. Read a reference file only for the component families you actually use.
---

# GenUI surface authoring

Emit one ```` ```genui ```` fence per interactive surface. The block is two regions:
`{@state}` directives first, then JSX-like markup. A fence mounts while it
streams: each element appears once its open tag closes — so declare all state
*before* the markup that reads it, or controls render with `undefined` values.

```genui
{@state const [value, setValue] = useState(65)}
{@state const [enabled, setEnabled] = useState(true)}

<card>
  <row>
    <heading level={3}>Progress</heading>
    <badge tone={enabled ? 'running' : 'neutral'}>{enabled ? 'Enabled' : 'Paused'}</badge>
  </row>
  <slider value={value} min={0} max={100} disabled={!enabled} onChange={(n) => setValue(n)} />
  <row>
    <switch checked={enabled} onCheckedChange={(v) => setEnabled(v)} />
    <text muted={!enabled}>Enable adjustment</text>
    <spacer />
    <button variant="secondary" size="small" onClick={() => setValue(65)}>Reset</button>
  </row>
</card>
```

## Rules that are enforced, not conventions

- `{@state const [x, setX] = useState(<expr>)}` is the *only* way to declare state.
  It must appear before the markup, never inside it. `x` is read in expressions;
  `setX(next)` or `setX((prev) => next)` writes it. Re-declared slots keep their
  committed value across revisions — `useState` is a *default*, not a reset.
- `{expr}` in markup is an *expression hole*: no `const`, `if`, or statements.
  Event props take JS callbacks: `onChange={(v) => setV(v)}`, `onClick={() => …}`.
- The evaluator is confined: literals, arithmetic, ternaries, template strings,
  arrow functions, array methods (`map/filter/find/reduce/sort/…`), calls into
  state setters and `lody.*` capabilities. No `window`/`fetch`/`import`/globals.
- Every tag must be in the catalog below — an unknown tag renders as an
  inline `<tag>` placeholder plus a diagnostic, never a crash.
- Text between tags is literal; wrap dynamic text in `{...}` expressions.

## Inline catalog tags (no fence)

Leaf, presentational tags also work inside ordinary markdown — sentences,
table cells, list items — with literal props only:

```markdown
| 检查项 | #2620 |
|---|---|
| CLI tests | <icon name="x-circle" color="danger" inline/> 失败 |

服务在线 <badge tone="success">running</badge>，一个仍在启动 <badge tone="warning">pending</badge>。
```

- Allowed tags: `icon`, `badge` (the `GENUI_INLINE_TAGS` allowlist).
- Self-closing `<icon ... />`, or the pair form `<badge ...>plain text</badge>`.
- Literal props and plain-text children only — `{expr}`, events, or nested
  markup keep the tag as raw text. A half-written tag renders as text until
  it closes.
- `icon` inline props: `name`, `color` (danger/success/warning/accent),
  `size`; `inline` is accepted and ignored — inline tags always render inline.

## Catalog index

Props that matter per tag; full prop tables and per-family examples live in
`references/` — read a family file only when you use it.

| Tag | Purpose | Key props |
|---|---|---|
| `card` | Grouped container | — |
| `row` / `column` | Flex row / column | `gap` (px) |
| `divider` | Horizontal rule | — |
| `spacer` | Pushes siblings apart | `size` |
| `text` | Body text | `muted` |
| `heading` | h1–h6 | `level` (default 3) |
| `badge` | Status pill | `tone`: neutral/success/warning/danger/running |
| `icon` | Lucide icon | `name` (kebab-case), `size` |
| `button` | Action | `onClick`, `variant`, `size`, `disabled` |
| `input` | Text field | `value`, `onValueChange(v)`, `placeholder`, `disabled` |
| `checkbox` / `switch` | Boolean toggle | `checked`, `onCheckedChange(v)`, `disabled` |
| `select` | Dropdown | `items`, `value`, `onValueChange(v)`, `placeholder` |
| `slider` | Numeric range | `value`, `min`, `max`, `step`, `disabled`, `onChange(n)` |

## References (read on demand)

- `references/expressions.md` — confined-JS subset, state semantics, `lody.*` capabilities, error shapes.
- `references/layout-text.md` — card, row, column, divider, spacer, text, heading, badge, icon: props, examples, misuse patterns.
- `references/controls.md` — button, input, checkbox, switch, select, slider: props, event contracts, worked examples.

## Validate before shipping

A surface that fails to compile degrades to its own fenced code block in chat —
readers never see diagnostics, so write markup as if errors were invisible. When
editing the runtime or catalog, the ground truth is `packages/genui` (parser +
evaluator) and `packages/components/src/components/ai-gui/genui/` (catalog
renderers); run `pnpm --filter @lody/genui test` to check a surface end-to-end.
