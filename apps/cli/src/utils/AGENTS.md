# CLI utilities

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and `apps/cli/AGENTS.md` also apply.

## Logging

- `logger.trace` (`LODY_LOG_TRACE=1`) exists because the daemon file log keeps
  `debug` and a per-token/per-tick `logger.debug` evicts the 20 MB rotation
  window; move a message to `trace` only if its subsystem stays diagnosable
  without it. Transports filter `trace` out unless the env flag is set.
- Winston `stderrLevels` and the `logStream` parameter are runtime-typed gaps:
  pass only the declared stream values and keep `meta` JSON-serializable.
- `encoding.ts` resolves display encoding from the console code page, never the
  OS locale; unknown code pages keep UTF-8.
