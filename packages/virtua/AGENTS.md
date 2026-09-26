# `@lody/virtua`

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only. Root `AGENTS.md` also applies.
Background and upstream sync steps: [README.md](README.md).

A fork of [Virtua](https://github.com/inokawa/virtua) 0.52.7 (MIT, `LICENSE`), vendored
as source: `src/core` and `src/react`. Other framework bindings are not carried.

## Invariants

- Keep upstream behavior unless a change is listed in README.md "Changes from upstream";
  mark every changed spot with a `Lody:` comment so an upstream sync can find it.
- `keyed` lists identify items by React key: sizes follow keys (also across a
  `CacheSnapshot`), and a list change keeps the item at the viewport start in place, in
  the store, before paint. That is the only anchoring on list changes: callers do not
  add a second scroll writer for it.
- Unkeyed lists and positional snapshots behave exactly as upstream.
- `src/` is excluded from the repository lint (its upstream idioms fail our type-aware
  rules); keep it close to upstream rather than restyling it. `tests/` is linted.
- Tests use explicit ResizeObserver deliveries and scroll events, never real sleeps.
  Upstream's jsdom snapshot suites (real 50ms sleeps) and browser suites are not carried.
