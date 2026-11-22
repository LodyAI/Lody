# Status view

`CLAUDE.md` is a symlink to this file. Parent contracts apply. Behavior:
[Status view](../../../../specs/sidebar-status-view.md) and
[pin sections](../../../../specs/pinned-session-sections.md); design and the
cross-platform contract: [phone note](../../../../.agents/notes/implemented/architecture/2026-11-21-status-view-on-phones.md).

- These modules are copied verbatim into the native clients' shared runtime at a
  pinned commit. They import only each other, `../pinned-sections.ts` and
  `../vendor/loro-fractional-index.ts`, never `@lody/*`, React or the DOM, and they
  never read a clock or a random source: the caller passes `nowMs` and `randomByte`.
- Every surface takes the Pinned area and the Focus, Later and Settled tiers from
  `buildStatusViewLayout`, and plans Status view and pin-section writes with
  `planStatusViewCommand`. A surface must not sort, classify or plan order keys for
  these lists itself; collapse state, "Show all" folding and countdown labels stay
  with the surface.
- The layout, command and write shapes are a JSON contract shared with the native
  runtime. Changing one is coordinated with that runtime and its vendored copy.
- `vectors/` is the golden output every consumer runs. `tests/status-view.test.ts`
  regenerates it with `vitest -u`; review the diff as the behavior change. The
  formatter skips the directory so the file stays byte-identical to the generator.
- A command the state cannot satisfy plans no writes rather than a partial set; the
  host still applies its own guard to every write it performs.
