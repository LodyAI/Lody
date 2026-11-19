# Workspace bundles

`lody workspace export --out <file>` writes a `.lodybundle`; `lody workspace import
<file> [--dry-run] [--yes]` merges one into a workspace. Owners and admins only. On
the local platform the CLI asks the daemon (local control `/workspace-bundle`)
because the daemon owns the only replica; cloud commands use their own workspace
manager and sync each room before reading and after writing.

| File                                      | Role                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `manifest.ts`, `zip.ts`, `bundle-file.ts` | Container: ZIP store entries, chunk and manifest hashes, 0600 atomic publish |
| `codecs.ts`                               | Room classification and the codecs import accepts                            |
| `export.ts`                               | Reads Meta, documents and named Flocks as raw bytes; records gaps            |
| `import.ts`                               | Plan (dry run), ordered merge, journal, Roost rewrite, import receipt        |
| `cross-workspace.ts`                      | Room id mapping and import fences for another workspace                      |
| `authorize.ts`                            | Row-level checks for changes to existing rows                                |
| `blobs.ts`                                | Local session-file attachments                                               |
| `service.ts`, `daemon.ts`, `control.ts`   | Entry points shared by the CLI command and the daemon                        |

## Current limits

- Relay-hosted files and images are recorded as gaps; only local session files are
  carried, and only those referenced by current history.
- Roost conversations are exported as visible turns and imported as Loro history
  for sessions the target does not have (lossy by owner decision).
- Prompt Shortcuts, the desktop Settings entry and cloud audit registration are not
  implemented yet.
- Storage is today's loro-repo; a native loro-repo-rs source and target adapter will
  reuse the same manifest, codecs and journal.
