# Workspace toolchain cache

This action restores the pnpm store by operating system, architecture and lockfile.
Only `pnpm-store-cache.yml` on `main` saves it, so other workflows and PRs can
reuse the default-branch cache.

Population uses hard-linked package imports before pruning. This keeps pnpm from
removing packages that macOS cloned into `node_modules`. The v2 key forces fresh
population even when an empty v1 cache exists; v1 remains a restore fallback for
stores that still contain useful packages. Consumers continue to install normally.

The [CI groups and store-cache decision](../../../.agents/notes/implemented/testing/2026-09-26-ci-test-groups-and-pnpm-store-cache.md)
records the ownership, measurements and clone/prune constraint.
