# @lody/code-review-helper

Standalone local code-review renderer and agent prompt package for Lody.

| Area           | Owner                                                     | Responsibility                                                               |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Review UI      | [`src/react`](src/react)                                  | Renders groups, diffs, findings and local comments.                          |
| Local controls | [`src/ui`](src/ui)                                        | Keeps the standalone renderer independent of product UI.                     |
| Styling builds | [`stylex-options.ts`](stylex-options.ts)                  | Shared StyleX configuration for Vite, Storybook, standalone HTML and Vitest. |
| Review format  | [File responsibilities](context/file-responsibilities.md) | Parsing, references and checklist ownership.                                 |

Owned renderer styles migrate progressively to local `stylex.create` blocks.
They read this package's existing CSS variables at the styled element; product
palette aliases can resolve at a different scope. Tailwind remains for control,
private-writer and third-party compatibility. Keep the original dark theme,
responsive layout and interactions; a styling change does not change reference
navigation, diff readiness or comment ownership.

The local DropdownMenu, Tooltip, Button, ToggleGroup and Separator use StyleX on ordinary
elements while preserving the original Tailwind cascade for legal Radix `asChild`
children. Slot concatenates parent and
child classes without resolving utility conflicts, so moving only parent defaults
to an earlier CSS layer can change child precedence. Exported Button/ToggleGroup
class selectors retain their raw utility values and order; one local CVA declaration
provides both the public legacy selector and the private owned selector. Runtime
StyleX mappings and source-utility removals are counted separately. Private font,
transition, ring and descendant rules remain until their writer contracts migrate.
Reviewed private text owners preserve each exact writer and physical reader:
tracking, leading and weight read their original element-local theme/literal;
numeric variants read all five numeric variables with empty fallbacks. A writer
alone is not a substitute for that reader. Full Storybook and standalone CSS
verification includes token pruning, actual fonts and visible numeric states;
public Slot, responsive heading and file-tree contracts stay on their audited paths.
Separator styling follows its existing JavaScript orientation branch; caller-written
or Radix-normalized data attributes do not choose its axis. Rendering the original
invalid-orientation case retains its original attribute/style mismatch.

The local Button exposes opt-in CSS-typed `width`, `height` and `labelColor`
fields for reviewed private consumers. They write actual inline CSS fields, so
CSS-wide keywords retain their field semantics. Existing caller `style` wins over
these declarations, and a Slot child's style retains its original final priority.
Omitting all three reuses the original style object. The raw variant selectors,
default classes and ordinary/Slot routes remain intact; the API does not migrate
raw public selectors or promise unchanged priority against arbitrary utility classes.

The four build/test entries share the same compiler options. CSS layers place
StyleX after base styles and before components/utilities. The standalone build
keeps source transforms pre and extracts CSS post, immediately before the
single-file inliner. Its generated HTML requires no stylesheet sidecar; the
[standalone pipeline](standalone-build.md#style-extraction-and-single-file-output)
owns that ordering and its `file://` verification.

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
