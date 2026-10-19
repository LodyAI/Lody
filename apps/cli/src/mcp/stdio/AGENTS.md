# Stdio MCP lifecycle

Parent MCP rules apply. `CLAUDE.md` is a symlink to this file.

- The command awaits connection termination, not merely `connect()`, before the
  CLI releases its shared application runtime. Execute only at the internal
  command entry; lifecycle composition uses Effect and scoped SDK/Node adapters.
- Subscribe before connecting; release event listeners and transport on every
  exit. Preserve combined startup/release failures. SDK close cancels request
  signals but does not establish arbitrary tool Promise completion.
- Keep SDK close/start assumptions version-matched and covered by the real SDK
  tests in `../stdio-lifecycle.test.ts`. Background: [MCP lifecycle](../README.md#stdio-lifetime).
