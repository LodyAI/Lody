# Controls

Every control is host-rendered from @lody/ui primitives. Event props take JS
callbacks; the argument is the control's value type.

## `button`

`onClick={() => …}`, `variant`: `secondary` (default) | `primary` | `ghost` |
`destructive` | `link`; `size`: `medium` (default) | `mini` | `small` | `large`;
`disabled`.

```genui
<button variant="primary" onClick={() => setSubmitted(true)}>Apply</button>
```

## `input`

Text field. `value` (string), `onValueChange={(v) => …}` (v: string),
`placeholder`, `disabled`.

```genui
<input value={name} placeholder="Search…" onValueChange={(v) => setName(v)} />
```

## `checkbox` / `switch`

Boolean toggles. `checked`, `onCheckedChange={(v) => …}` (v: boolean),
`disabled`. Prefer `switch` for enable/disable settings, `checkbox` for
selection lists.

```genui
<switch checked={enabled} onCheckedChange={(v) => setEnabled(v)} />
```

## `select`

Dropdown. `items`: array of strings or `{value, label}` objects; `value`
(string); `onValueChange={(v) => …}` (v: string | null); `placeholder`;
`disabled`.

```genui
<select
  items={[{value: 'a', label: 'Option A'}, {value: 'b', label: 'Option B'}]}
  value={choice}
  placeholder="Pick one"
  onValueChange={(v) => setChoice(v)}
/>
```

## `slider`

Numeric range. `value` (number), `min` (0), `max` (100), `step` (1),
`disabled`, `onChange={(n) => …}` (n: number). Renders the current value at
the trailing edge.

```genui
<slider value={level} min={0} max={10} step={0.5} onChange={(n) => setLevel(n)} />
```

## Worked example: gated control

```genui
{@state const [value, setValue] = useState(50)}
{@state const [locked, setLocked] = useState(false)}

<card>
  <row>
    <text>Level</text>
    <spacer />
    <text muted>{value}</text>
  </row>
  <slider value={value} disabled={locked} onChange={(n) => setValue(n)} />
  <row>
    <checkbox checked={locked} onCheckedChange={(v) => setLocked(v)} />
    <text muted={!locked}>Lock</text>
  </row>
</card>
```
