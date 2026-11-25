# svg diagrams

Two ways to draw: **`Diagram`** for structured layered/flow pictures — you give
data, it computes every coordinate — and the lowercase **`svg` family** for
hand-placed shapes when you need exact control.

## Prefer `Diagram` for architecture and flows

`Diagram` renders a top-down layered diagram. You describe *what* connects, not
*where*; the layout (positions, sizing, alignment, label placement) is computed
for you, so output stays aligned without hand-written coordinates.

```genui
<Diagram
  layers={[
    { label: 'Clients', items: [
      { id: 'desk', title: 'Desktop' },
      { id: 'web', title: 'Web' },
      { id: 'mob', title: 'Mobile' },
    ]},
    { label: 'Daemon', items: [
      { id: 'core', title: 'Core', subtitle: 'Projects · Threads · Runtime' },
      { id: 'ext', title: 'Extensions' },
    ]},
    { items: [{ id: 'run', title: 'External runners', tone: 'accent' }] },
  ]}
  edges={[
    { from: 'web', to: 'core', label: 'RPC' },
    { from: 'core', to: 'run', dashed: true },
  ]}
/>
```

- `layers` — array of bands, top to bottom. Each layer: `label` (optional,
  small-caps band header), `items` (array of boxes), optional `tone`.
- item — `id` (edge anchor, unique), `title`, optional `subtitle`, `tone`.
- `edges` — `from`/`to` are item `id`s; `label`, `tone`, `dashed` optional.
- `tone: 'accent'` highlights a box, band, or edge with the accent colour.
- Items in a layer share the band width evenly; edges run bottom-of-source to
  top-of-target. An edge naming a missing `id` is skipped.
- `aria-label` sets the accessible name (default `diagram`).

Reach for `Diagram` before hand-writing `<svg>`: it is the disciplined default.
Drop to the `svg` family only for a shape `Diagram` cannot express — a free-form
wireframe, a sequence chart, or a single annotated figure.

## `svg` family — hand-placed shapes

`<svg>` draws custom diagrams, wireframes, and charts inline — the family keeps
real lowercase SVG element names, unlike the PascalCase catalog components. It
is a confined subset: only the elements and attributes below exist, so a
surface can paint vector shapes but never load resources, embed HTML, or run
handlers. The one exception is `svg:text`, namespaced to stay distinct from
the prose `Text` tag.

### Typography discipline

Hand-placed SVG looks clean only with restraint. Follow this scale:

- Font sizes: `8` (captions), `9` (labels), `10` (item titles), `11–12`
  (section titles). `font-weight="600"` for titles only; everything else `400`.
- Colour: `currentColor` for all text. Fills use `currentColor` with
  `fill-opacity` in `.05` / `.08` / `.12` / `.15` bands. One accent hue maximum
  (e.g. `#8b5cf6`), reserved for the single element you want highlighted.
- Outlines: `stroke="currentColor"` `stroke-opacity=".25"–.35`; dashed
  connectors via `stroke-dasharray="4 3"` or `"3 3"`.

## Elements

- `svg` — root. `viewBox` (e.g. `"0 0 340 220"`), `width`, `height`,
  `preserveAspectRatio`, `role`, `aria-label`.
- `g` — group. Shares paint attributes plus `transform`.
- `rect` — `x`, `y`, `width`, `height`, `rx`, `ry`.
- `circle` — `cx`, `cy`, `r`. `ellipse` — `cx`, `cy`, `rx`, `ry`.
- `line` — `x1`, `y1`, `x2`, `y2`.
- `polyline` / `polygon` — `points` (e.g. `"0,0 10,10 20,0"`).
- `path` — `d`.
- `svg:text` / `svg:tspan` — labels. `x`, `y`, `dx`, `dy`, `rotate`,
  `text-anchor`, `font-size`, `font-weight`, `font-family`, `letter-spacing`.

## Paint attributes

All elements accept `fill`, `stroke`, `stroke-width`, `stroke-dasharray`,
`stroke-dashoffset`, `stroke-linecap`, `stroke-linejoin`, `fill-opacity`,
`stroke-opacity`, `fill-rule`, `opacity`, `transform`, `color` (sets
`currentColor`), `vector-effect`. Use `fill="none"` for outlines and
`fill="currentColor"` to follow the theme. An attribute not in this contract
is dropped, not rendered.

```genui
<svg viewBox="0 0 340 220">
  <rect x="3" y="3" width="334" height="214" rx="7" stroke="currentColor" fill="none" />
  <rect x="4" y="25" width="94" height="188" fill="currentColor" opacity=".05" />
  <svg:text x="13" y="43" font-size="9">Workspace</svg:text>
</svg>
```

Expressions drive geometry, so a diagram can reflect state:

```genui
{@state const [level, setLevel] = useState(60)}
<Column>
  <svg viewBox="0 0 200 20">
    <rect width={level * 2} height="20" rx="4" fill="currentColor" opacity=".3" />
  </svg>
  <Slider value={level} max={100} onChange={(n) => setLevel(n)} />
</Column>
```

## Misuse patterns

- `<text>` inside `<svg>` renders as a paragraph, not a label — use `svg:text`.
- `image`, `foreignObject`, `use`, `a`, `script`, and `animate*` elements are
  not in the catalog; neither are `href`, `style`, `class`, or `on*` attributes.
- Set geometry as attributes, not `style`: `x="10"`, never `style="left:10px"`.
