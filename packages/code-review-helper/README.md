# @lody/code-review-helper

Standalone local code-review renderer and agent prompt package for Lody.

| Area           | Owner                                                     | Responsibility                                                               |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Review UI      | [`src/react`](src/react)                                  | Renders groups, diffs, findings and local comments.                          |
| Local controls | [`src/ui`](src/ui)                                        | Keeps the standalone renderer independent of product UI.                     |
| Styling builds | [`stylex-options.ts`](stylex-options.ts)                  | Shared StyleX configuration for Vite, Storybook, standalone HTML and Vitest. |
| Review format  | [File responsibilities](context/file-responsibilities.md) | Parsing, references and checklist ownership.                                 |

Renderer and local controls use `stylex.create` with this package's HSL theme
variables. The package has no Tailwind, CVA, utility-class merge or CSS-macro
build dependency. [`src/react/styles.css`](src/react/styles.css) owns the small
base reset, default variables, private property registrations and diff integration
rules. `@pierre/diffs` keeps its own shadow-root styles.

Local controls expose optional `xstyle` for owned styling and retain Radix Slot
rendering, events and refs. Defaults and caller styles compose once inside the
control; explicit caller and Slot-child inline styles retain priority. Exported
Button/ToggleGroup variant functions return generated StyleX class strings.
These are selectors for the current styles, not a utility-class API. Root
`ToggleGroup.asChild` retains its existing provider boundary and does not forward
box styles through it; use a normal Root when styling the group box.

Button's optional CSS-typed width, height, label color, gap and padding fields,
and ToggleGroup's gap/padding fields, still preserve CSS-wide values and caller
shorthand/longhand order. Omitting the fields keeps the original style object.
The `crh-size-explicit` glyph hook preserves the controls' existing SVG-size
opt-out for the renderer's explicit glyphs.

The standalone theme provider applies Vesper. Browser light/dark preferences do
not switch it to a different palette. Embedded hosts can omit the provider and
supply the documented HSL variables. Private `--crh-*` writer/reader chains and
registrations are owned here; they do not depend on framework initialization.
The literal annotation/composer fonts stay in element-local custom properties
because the locked CSS optimizer expands a direct `system-ui` declaration.

Development, Storybook, tests and standalone builds share the compiler options.
The standalone build transforms source before Vite and extracts CSS immediately
before the single-file inliner, so its `file://` output needs no stylesheet
sidecar. See [the standalone pipeline](standalone-build.md).

## Review file format (`.review.md`)

A `.review.md` file organizes a PR or commit range into human-reviewable groups.

### Frontmatter

```yaml
---
review_version: 1
merge_base: <full base sha>
current_commit: <full head sha>
base_ref: <optional base ref>
line_budget: 1500
pr_number: <optional PR number>
pr_url: <optional PR URL>
pr_title: <optional PR title>
---
```

### Overall summary

After the frontmatter, write a single `# Title` heading and a short prose summary.
This is rendered as the change overview.

### Groups

Each group starts with `## Group: <title>` and contains:

- Optional `Changed lines: <n>` and `Commits: \`sha\`, \`sha\`` metadata.
- A structured description (Purpose, Flow, Invariants, Risks, Reviewer checklist).
- One or more code blocks:
  - `changes://path?old=Lx-Ly&new=La-Lb` — a changed file (diff). Omit ranges when the
    whole file is small enough to review.
  - `context://path?range=Lx-Ly` — an unchanged file or unchanged range referenced for
    context. The renderer shows only the requested range plus surrounding lines.
- Line notes bound to the nearest preceding block:

```md
- INFO `new://L42`: neutral context.
- QUESTION `new://L45`: something unclear.
- WARNING `new://L50`: possible issue.
- ERROR `new://L55`: high-confidence bug or breaking change.
```

### Severity guidelines

- `ERROR` — use only when you are fairly sure there is a bug, breaking change, data
  loss, or security issue.
- `WARNING` — a real risk or scope concern that needs reviewer attention.
- `QUESTION` — uncertainty or a design question; lighter than `WARNING`.
- `INFO` (default) — context that helps reviewers understand the change.

### Line budget

`line_budget` is a soft guideline, not a hard limit. Groups should stay semantically
coherent; they may be much smaller or larger than the budget when the logic demands it.
