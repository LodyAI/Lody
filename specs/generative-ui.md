# Generative UI

Status: draft
Translation: pending

Agents answer with declarative, stateful UI embedded in Markdown, beyond what
`html render` offers: the components are Lody's own, the state belongs to the
host, and the model never ships executable web code.

## Scenario

An assistant turn wants to show a slider that filters a list, a toggle that
changes a recommendation, or a button that copies a result. Writing raw HTML
into the answer is the escape hatch: it can do anything, including things the
host never agreed to, and it renders web chrome inside a native conversation.
The generative path instead lets the model emit a restricted component tree
with host-owned interaction state, rendered by `@lody/ui` primitives under the
theme already in place.

## Responsibilities

- **Surface source**: a fenced ```` ```genui ```` block inside assistant
  Markdown. The block contains JSX-subset markup plus `{@state}` directives.
  An incomplete (still streaming) fence stays a plain code block; the surface
  commits only when the fence closes.
- **`@lody/genui` (packages/genui)**: the framework-free runtime — directive
  splitting, acorn/acorn-jsx parsing into a `UiNode` tree, a confined
  interpreter for `{expr}` holes and callbacks, and `SurfaceState`, the
  versioned host-owned state store. No React, no DOM.
- **The React adapter** (`components/ai-gui/genui/`): `GenuiSurface` compiles
  the source, holds per-surface state across remounts, re-evaluates
  expressions on each committed state write, and maps tags through
  `GENUI_CATALOG` to @lody/ui components.
- **The catalog**: the complete list of tags the model may use. Unknown tags
  render as diagnostics, not DOM.

## Wire format

```genui
{@state const [value, setValue] = useState(65)}
{@state const [enabled, setEnabled] = useState(true)}
<card>
  <heading level={4}>Progress</heading>
  <slider value={value} min={0} max={100} disabled={!enabled} onChange={(n) => setValue(n)} />
  <checkbox checked={enabled} onCheckedChange={setEnabled} />
  <button onClick={() => setValue(65)}>Reset</button>
</card>
```

- `{@state}` bodies accept only `const [name, setName] = useState(init)`
  declarations; state is declared at top level, never inside markup or
  callbacks.
- Expressions are confined JavaScript: literals, arithmetic, ternaries,
  template strings, arrow functions, member/call on reachable values, and the
  common array callback methods. There are no ambient globals, no `import`,
  no async, no `eval`, and `__proto__`/`prototype`/`constructor` access is
  refused. Evaluation runs under a step and call-depth budget.
- Event props are ordinary expressions evaluating to functions; host
  capabilities arrive under the `lody` namespace (e.g. `lody.copy(...)`), the
  only bridge out of the surface.

## Guarantees

- State slots are addressed by `surfaceId` (falling back to the fence's
  code), so a re-rendered or revised surface keeps committed user input; a
  re-declared slot keeps its value — initializers run once.
- Any failure — unparseable markup, bad directive, evaluation error, unknown
  tag — degrades to a diagnostic view, never a thrown render or a partial DOM.
- The catalog is the contract: nothing outside it can reach the DOM, the
  network, or host APIs.

## Unresolved questions

- Persisting surface state into the session document (Loro) so state
  survives restart, vs. session-scoped memory only.
- Whether streaming *inside* a committed surface (token-level updates to an
  already-rendered tree) is needed, or commit-on-fence-close suffices.
- A `Slider` primitive belongs in `@lody/ui`; the catalog currently uses a
  styled native range input.
- Action protocol for `lody.*` capabilities (submit message, open file) and
  how capabilities declare availability per surface.

## Evidence

- Runtime: `packages/genui/src/` (`directives.ts`, `jsx.ts`, `evaluate.ts`,
  `state.ts`, `surface.ts`); tests in `packages/genui/test/genui.test.ts`.
- React adapter: `packages/components/src/components/ai-gui/genui/`.
- Fence dispatch: `markdown-renderer.tsx` `MarkdownPre` (`genui` language).
