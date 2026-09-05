# `src/components/prototypes`

Interaction prototypes for features that have a design document but no
implementation. They exist to be looked at in Storybook and argued about, not
to ship.

Parent `AGENTS.md` files also apply, with the deviations recorded below.

## Invariants

- **Nothing here is imported by product code.** No route, no atom, no hook that
  touches Flock, Convex, Machine RPC, or the network. A prototype that acquires
  a production consumer is no longer a prototype and must move out of this
  directory and take on the full rules of its destination.
- Data comes from a closed, deterministic fixture module in the prototype's own
  folder — no clock, no randomness, no fetch — so a story renders the same
  pixels on every run and can be diffed in review.
- Reuse the real visual language: `src/ui` primitives, `ui/menu-styles.ts`,
  `settings/form-primitives.tsx`, and the composer's own chip table in
  `components/mentions/mention-chips.tsx`. A prototype that invents its own
  spacing and colour is answering a question nobody asked.
- Prefer computing a state over drawing it. The point of a runnable prototype
  over a mockup is that the derived states — requirement pills, availability,
  send gates — react to input, which is exactly where a design is wrong or
  right.

## Deviation: i18n

Copy in this directory is inline English, not `t()`. The package rule is that
user-visible copy goes through i18n; a prototype is exempt because its strings
are proposals under review and would otherwise land ~60 speculative keys, plus
their translations, in the shipped locale files before anyone has agreed to the
feature. **Moving a prototype toward production means moving its copy to
`locales/*.json` first.**

## Current prototypes

- `prompt-shortcuts/` — `docs/prompt-shortcuts.md` (private repo). Settings
  catalog, editor, `/` menu, invocation chip + variable tray, expand-and-edit.
  Stories: `src/stories/PromptShortcutsPrototype.stories.tsx`.

  Two places where the prototype deliberately disagrees with that document, on
  product-owner review: the template is ONE field rather than an ordered block
  list (blocks were joined into one message anyway, so they were a second way to
  press Enter), and the derived requirements are one "Runs in" pill row under
  the field rather than their own section (the references are already visible in
  the prompt above it; a table restated them). The editor also carries a
  "Browse from" project/machine pair, which is §3.3's source-first mention menu
  as a persistent control — it scopes what `@` offers and never sets a
  requirement itself.
