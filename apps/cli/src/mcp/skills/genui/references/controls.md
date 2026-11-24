# Controls

Every control is host-rendered from @lody/ui primitives. Event props take JS
callbacks; the argument is the control's value type.

## `Button`

`onClick={() => …}`, `variant`: `secondary` (default) | `primary` | `ghost` |
`destructive` | `link`; `size`: `medium` (default) | `mini` | `small` | `large`;
`disabled`.

```genui
<Button variant="primary" onClick={() => setSubmitted(true)}>Apply</Button>
```

## `Input`

Text field. `value` (string), `onValueChange={(v) => …}` (v: string),
`placeholder`, `disabled`.

```genui
<Input value={name} placeholder="Search…" onValueChange={(v) => setName(v)} />
```

## `Checkbox` / `Switch`

Boolean toggles. `checked`, `onCheckedChange={(v) => …}` (v: boolean),
`disabled`. Prefer `Switch` for enable/disable settings, `Checkbox` for
selection lists.

```genui
<Switch checked={enabled} onCheckedChange={(v) => setEnabled(v)} />
```

## `Select`

Dropdown. `items`: array of strings or `{value, label}` objects; `value`
(string); `onValueChange={(v) => …}` (v: string | null); `placeholder`;
`disabled`.

```genui
<Select
  items={[{value: 'a', label: 'Option A'}, {value: 'b', label: 'Option B'}]}
  value={choice}
  placeholder="Pick one"
  onValueChange={(v) => setChoice(v)}
/>
```

## `Slider`

Numeric range. `value` (number), `min` (0), `max` (100), `step` (1),
`disabled`, `onChange={(n) => …}` (n: number). Renders the current value at
the trailing edge.

```genui
<Slider value={level} min={0} max={10} step={0.5} onChange={(n) => setLevel(n)} />
```

## Worked example: gated control

```genui
{@state const [value, setValue] = useState(50)}
{@state const [locked, setLocked] = useState(false)}

<Card>
  <Row>
    <Text>Level</Text>
    <Spacer />
    <Text muted>{value}</Text>
  </Row>
  <Slider value={value} disabled={locked} onChange={(n) => setValue(n)} />
  <Row>
    <Checkbox checked={locked} onCheckedChange={(v) => setLocked(v)} />
    <Text muted={!locked}>Lock</Text>
  </Row>
</Card>
```
