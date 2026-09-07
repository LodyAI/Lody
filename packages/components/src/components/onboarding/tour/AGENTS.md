# Onboarding tour

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Parent `AGENTS.md` files also apply — the rules about which screens may show the
tour, and about the illustrated intro, live in
[../AGENTS.md](../AGENTS.md). What follows binds the tour composition itself.

- `TourApp` reuses production components against fixture state, so it must remain inside `TourCloudBoundary`. The boundary owns fixture identity, workspace, authentication, and cloud operations; no tour child may observe or call the outer app's cloud adapter.
- The tour's runtime is a stand-in on BOTH planes: `TourCloudBoundary` for cloud operations and `createTourRepo` for `runtime.repo`. The reused components read as well as write — the composer opens the workspace catalog and machine Flock documents — so every tour document must open, read empty, and report its first remote sync as done, and writes on either plane must reject rather than silently succeed. Supply the missing plane; do not fork a repo-free copy of a product component to avoid it.
