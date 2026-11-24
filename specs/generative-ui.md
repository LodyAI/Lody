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
  A committed fence mounts as a live surface; a fence still streaming mounts
  through the tolerant partial compile: elements appear as their open tags
  close, children stream into open elements, and the truncated tail waits
  offscreen — only closed constructs ever land.
- **Inline tags**: leaf catalog tags (`GENUI_INLINE_TAGS`, currently `icon`
  and `badge`) may also appear directly in ordinary Markdown — inside a
  sentence or a table cell — as `<icon ... />` or `<badge ...>text</badge>`.
  Literal props and plain-text children only; expressions, events, nested
  markup, or non-allowlist tags leave the markup as plain text. A remark
  pass (`remarkGenuiInline`) rewrites qualifying nodes to the same
  `GENUI_CATALOG` renderers, and a tag commits only when it closes, so a
  half-streamed tag never mounts.
- **`@lody/genui` (packages/genui)**: the framework-free runtime — directive
  splitting, acorn/acorn-jsx parsing into a `UiNode` tree, a confined
  interpreter for `{expr}` holes and callbacks, and `SurfaceState`, the
  versioned host-owned state store. No React, no DOM. `compileSurfacePartial`
  is the streaming counterpart: committed directives and nodes compile as
  usual while the truncated tail returns as `pending` with no diagnostics.
- **The React adapter** (`components/ai-gui/genui/`): `GenuiSurface` compiles
  the source, holds per-surface state across remounts, re-evaluates
  expressions on each committed state write, and maps tags through
  `GENUI_CATALOG` to @lody/ui components. Only committed nodes reach the DOM:
  the uncommitted streaming tail is withheld, not shown as raw markup.
- **The catalog**: the complete list of tags the model may use. Unknown tags
  render as diagnostics, not DOM.
- **Catalog delivery**: the model learns the DSL through progressive
  disclosure — a compact index (every tag, one line each: purpose and key
  props) is always in context, while full prop tables and worked examples live
  in per-family reference documents the model reads only for the component
  families it uses. The skill and references live in
  `apps/cli/src/mcp/skills/genui/` and reach agents through the Lody MCP
  server's skills extension (`skill://genui/SKILL.md`). Delivery is static, not runtime-negotiated: the
  catalog ships inside Lody's own prompt/skill documents, so the DSL the
  model sees is versioned with the release that renders it — no per-request
  injection, no prompt-cache breakage, no version skew between what the
  model may emit and what the host accepts.

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
  only bridge out of the surface. The capability set is static: a fixed
  manifest documented in the skill and bound by the same Lody release, never
  negotiated per surface or per request — a call to an absent member
  produces a diagnostic like any other catalog violation.

## Guarantees

- State slots are addressed by `surfaceId` — the fence's document offset while
  it streams — so a re-rendered or revised surface keeps committed user input;
  a re-declared slot keeps its value — initializers run once.
- Any failure — unparseable markup, bad directive, evaluation error, unknown
  tag — degrades, never a thrown render or a partial DOM. A surface that
  cannot mount at all falls back to its own fenced code block: parse
  diagnostics are model-facing (the error feedback loop below), never
  reader-facing.
- The catalog is the contract: nothing outside it can reach the DOM, the
  network, or host APIs.

## Unresolved questions

- Persisting surface state into the session document (Loro) so state
  survives restart, vs. session-scoped memory only.
- Whether revision patching (the agent updating an already-mounted surface
  rather than appending) is needed — prefix streaming mounts new nodes, but
  there is no protocol for editing a committed tree.
- A `Slider` primitive belongs in `@lody/ui`; the catalog currently uses a
  styled native range input.
- `lody.*` capabilities: the first manifest ships `sendPrompt(text)`, which
  submits a user message on the conversation's ordinary send path
  (queue/guide/dispatch routing, like the composer). Further members
  (open file, copy) extend the same static manifest.
- The error feedback loop: surface diagnostics are model-facing but not yet
  reported back to the agent, so a rejected surface cannot currently
  trigger a describe-and-retry repair.

## Evidence

- Runtime: `packages/genui/src/` (`directives.ts`, `jsx.ts`, `jsx-partial.ts`,
  `evaluate.ts`, `state.ts`, `surface.ts`); tests in
  `packages/genui/test/genui.test.ts`.
- React adapter: `packages/components/src/components/ai-gui/genui/`.
- Inline dispatch: `remark-genui-inline.ts` + the `genui-inline` entry in
  `markdown-renderer.tsx` `createMarkdownComponents`; tests in
  `remark-genui-inline.test.ts`.
- Fence dispatch: `markdown-renderer.tsx` `MarkdownPre` (`genui` language).
- Authoring contract: `apps/cli/src/mcp/skills/genui/` (index + per-family
  references, served as the `genui` skill over Lody MCP).
