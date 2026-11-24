# Expressions, state, and capabilities

## Where JS can appear

- `{@state const [x, setX] = useState(<expr>)}` — state declarations, top of block only.
- `{expr}` inside markup text — a value hole.
- `prop={expr}` — a prop value; `prop="literal"` for strings; bare `prop` means `true`.
- `prop={(args) => expr}` — event callbacks; the arrow body may also be `{ stmt; stmt }`.

## Dynamic values in a fixed view

Write tags directly in the markup. Inside `{expr}`, compute text or prop
values. JSX elements and fragments inside expressions are unsupported, including
in ternary branches and `map` callbacks.

```genui
{@state const [ready, setReady] = useState(false)}
<switch checked={ready} onCheckedChange={(checked) => setReady(checked)} />
<text muted={!ready}>{ready ? 'Ready' : 'Waiting'}</text>
<text>{['alpha', 'beta', 'gamma'].filter((name) => name.includes('m')).map((name) => name.toUpperCase()).join(', ')}</text>
```

Use a ternary for alternate text or prop values. For a variable-length list,
map to strings and join them inside a single `<text>` tag.

## The confined JS subset

Supported: literals (numbers, strings, booleans, `null`, arrays, object literals),
arithmetic/comparison/logical operators, ternaries, template strings, arrow
functions, destructuring in declarations, member access, calls, and the common
array methods (`map`, `filter`, `forEach`, `find`, `findIndex`, `findLast`,
`every`, `some`, `flatMap`, `sort`, `reduce`, `reduceRight`) — including with
arrow callbacks.

Ambient safe values: `Math`, `JSON`, `Number`, `String`, `Boolean`, `Array`,
`Object.keys/values/entries/assign/fromEntries`, `isNaN`, `isFinite`,
`parseFloat`, `parseInt`, `undefined`, `NaN`, `Infinity`.

Not available: `window`, `document`, `fetch`, `import`, `require`, `eval`,
`Function`, `async`/`await`, `setTimeout`, any other global. Member reads of
`__proto__`, `prototype`, `constructor` are denied. Statements (`const`, `let`,
loops, `if`) work inside `{@state}` initializer positions and arrow bodies only —
never inside `{expr}` holes.

## State semantics

- `useState(init)` takes the initializer **only on first mount** of that slot.
  When the surface code changes (a new revision) but the surface key is the same,
  re-declared names keep the user's committed values — write `useState(65)` as a
  default, not a reset.
- `setX(v)` replaces; `setX((prev) => v)` updates from the committed value.
- All expressions re-evaluate on every state change — no dependency tracking.
  Keep derived values inline (`{enabled ? 'On' : 'Off'}`) rather than stored.
- Events call setters directly: `onChange={(n) => setValue(n)}`. Callbacks
  capture the current scope.

## Host capabilities (`lody.*`)

Hosts inject a `lody` object of capability functions. The manifest is fixed per
release — only call members listed here; an absent function surfaces a
diagnostic instead of running.

- `lody.sendPrompt(text)` — submits `text` as a user message on the current
  conversation, on the ordinary send path (queues behind a busy agent like the
  composer). Use for buttons that hand the reader a ready-made next step:
  `<button onClick={() => lody.sendPrompt('Fix the failing checks')}>Fix CI</button>`.

## Error shapes

- Bad `{@state}` syntax → `state` diagnostic on the surface.
- Bad markup/attribute → `jsx` diagnostic; the rest of the view still renders.
- Unknown tag → renders `<tag>` inline + `catalog` diagnostic.
- Expression that throws or hits the step budget → `eval` diagnostic.

Diagnostics are model-facing, not reader-facing: in chat a surface that cannot
mount degrades to its own fenced code block, and the truncated tail of a
still-streaming fence is withheld rather than shown as raw markup. Only a
direct `GenuiSurface` without a `fallback` shows the error view.
