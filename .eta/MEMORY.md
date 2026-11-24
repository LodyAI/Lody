# eta memory (untrusted)
## decision
- [0] When inheriting uncommitted work from a prior run, fully verify it against acceptance criteria before committing — don't trust it sight unseen.
- [1] For regenerated binaries, prove provenance by re-running the generator and comparing bytes (sha256), not just visual/plausibility checks.
- [2] New validation checks must be tested against the old/corrupt input too — include both failing and passing outputs as evidence.
- [3] Do not merge to main unless the task explicitly says to; commit in the worktree and finish with evidence for review.
## preference
- [4] Fail loudly at packaging time on corrupt assets; guard platform-specific checks (e.g. darwin) if the pipeline is cross-platform.
- [9] A review comment that is only verification/recommends accept (no change request, no question) requires no new work — confirm the worktree is clean and the commit stands, then hand back for final accept.
## lesson
- [5] apps/electron/scripts/** is in oxlint's ignorePatterns repo-wide — lint 'passing' there means unchecked; oxfmt is the real gate for those files.
- [6] Workspace typecheck in a fresh worktree fails on missing packages/acp-extension-core (directory absent entirely) — pre-existing, unrelated to touched .mjs files which aren't in any tsconfig include.
- [7] pnpm install in a fresh worktree fails the preinstall Node-version gate (requires >=v26.12.1) but dependencies still land — check usability rather than assuming total failure.
- [8] git diff doesn't show untracked files — an empty diff after formatting doesn't mean nothing changed; check file state directly.
- [10] An untracked `.eta/` directory appears in task worktrees — it's agent session/runtime metadata, not code; never commit it, and don't mistake it for a real working-tree change.
