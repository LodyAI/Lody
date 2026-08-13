# CLI File Preview v3

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and `apps/cli/AGENTS.md` also apply.

Serves the `file/preview` Machine RPC method: read one file, return it.

## The invariant that justifies this directory existing

**A preview MUST NOT activate Code Collab.** No `ensureWorkspaceWatch`, no
`reconcilePathState`, no All Changes recompute, no Flock publication, no mutation of
any `CodeCollabV2Service` state. Previewing used to ride on `code-collab/open-text`,
which did all of that per click — an O(1) read turned into an O(workspace) job.

If a future feature here needs shared state, it belongs in `CodeCollabV2Service`
instead. Code Collab's `open-text` / `refresh-text` stay on the machine for older
clients (the CLI auto-updates independently of a loaded web bundle) and for the
save path's text reads.

## Files

- `file-preview-service.ts` — resolves the workspace, authorizes the path, reads,
  classifies text vs binary, encodes, and answers. Never throws for a domain
  failure: every rejection is a typed `status: 'error'` response.
- `file-preview-path-policy.ts` — the security boundary. Allowed roots are the
  session workspace root, `os.tmpdir()`, `<LodyDataDir>/chats`, and anything in
  `LODY_FILE_PREVIEW_EXTRA_ROOTS`.

## Load-bearing details

- The `.lody` data-dir ROOT is deliberately not an allowed root: it holds
  `credentials.json` and the git credential broker state. Allowlist named
  subdirectories, never their parent.
- Containment is checked against the **symlink-resolved** target, so a link inside
  the workspace pointing at `~/.ssh/id_rsa` is rejected.
- A missing file reports `file_not_found` only when its lexical path was inside an
  allowed root; otherwise `path_not_allowed`. Otherwise the two codes become an
  existence probe for paths outside the boundary.
- Oversize is refused, never truncated — half a PNG is a corrupt file, and half a
  JSON is a syntax error. The read takes one byte past the limit so a file that grew
  between `stat` and `read` is caught.
- Binary detection is content-first (NUL sniff, then a failed UTF-8 decode), but a
  known image extension forces the binary path: an image whose header happens to
  avoid NUL bytes would otherwise ship as mojibake text.
- The `path_not_allowed` message must keep the phrase "File is outside the
  workspace" — the web error surface keys its dedicated presentation off that text
  (`session-file-error-state.tsx`), because the generic `permission-denied` copy
  ("Access denied") misdescribes a policy rejection as a filesystem one.

Normative contract: `specs/file-preview-v3.md` (private repo). Schemas:
`packages/shared/src/file-preview.ts`.
