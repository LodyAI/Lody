# CLI File Preview v3

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` and `apps/cli/AGENTS.md` also apply.

Serves the `file/preview` Machine RPC method: read one file, return it. File
responsibilities and the reasoning behind these rules: [README.md](README.md).

## The invariant that justifies this directory existing

**A preview MUST NOT activate Code Collab.** No `ensureWorkspaceWatch`, no
`reconcilePathState`, no All Changes recompute, no Flock publication, no mutation of
any `CodeCollabV2Service` state. Previewing used to ride on `code-collab/open-text`,
which did all of that per click — an O(1) read turned into an O(workspace) job.

If a future feature here needs shared state, it belongs in `CodeCollabV2Service`
instead. Code Collab's `open-text` / `refresh-text` stay on the machine for older
clients (the CLI auto-updates independently of a loaded web bundle) and for the
save path's text reads.

## Invariants

- `file-preview-service.ts` never throws for a domain failure: every rejection is a
  typed `status: 'error'` response.
- `file-preview-path-policy.ts` is the security boundary. Remote `file/preview`
  requests may read only the session workspace root, `os.tmpdir()`,
  `<LodyDataDir>/chats`, and `LODY_FILE_PREVIEW_EXTRA_ROOTS`. The separate
  local-only `file/resolve-local` IPC method is the Electron user's explicit
  same-machine capability and resolves any regular file for Electron; it returns
  identity only, never bytes, and is never added
  to the Loro Streams RPC protocol.
- The `.lody` data-dir ROOT is deliberately not an allowed root: it holds
  `credentials.json` and the git credential broker state. Allowlist named
  subdirectories, never their parent.
- Authorization is checked against the **symlink-resolved** target and roots, so a
  link inside the workspace pointing at `~/.ssh/id_rsa` is rejected.
- **Resolution and authorization are separate steps, only one of them folds case,
  and they must not be merged.** RESOLUTION may walk the path down from the
  workspace root matching each segment case- and NFC/NFD-insensitively (the same
  `pathSegmentComparisonKey` rule the file index is built with), appending either
  the requested name verbatim or ONE listed entry that folds to it, and refusing
  `.`/`..` so it cannot climb or invent a segment. AUTHORIZATION containment stays
  case-SENSITIVE with no fallback and runs on the symlink-resolved result.
- **Preview reads case-tolerantly; writes stay case-exact.** `save-text` and
  `refresh-text` keep going through the case-intolerant resolver.
- Ambiguity declines, it does not guess: more than one entry folding to the
  requested spelling returns no match. Probe the byte-identical name first.
- Try the verbatim request before the trimmed one: `" notes.md"` is a real
  filename, so trimming first made it permanently unopenable.
- Missing-path classification requires EVERY candidate spelling to be inside an
  allowed root (`every`, never `some`), or the two error codes become an existence
  oracle for the whole filesystem. Regression test: "does not turn not-found vs
  not-allowed into an existence probe past the boundary".
- A missing target has no realpath, so classify it against BOTH the resolved and the
  unresolved roots. That step only picks the error code; it never grants a read, and
  it still reports `file_not_found` only inside an allowed root.
- Unit-test the fold rule through an injected `FilePreviewDirectoryReader`
  (`file-preview-path-policy.test.ts`), not only against the real filesystem.
- Remote oversize is refused, never truncated. The read takes one byte past the limit so a
  file that grew between `stat` and `read` is caught.
- Binary detection is content-first (NUL sniff, then a failed UTF-8 decode), but a
  known RASTER image extension forces the binary path: an image whose header happens
  to avoid NUL bytes would otherwise ship as mojibake text. Use `isBinaryImagePath`,
  NOT `getImageMimeTypeForPath` — the latter also matches SVG, which is XML text and
  must stay on the text path to keep its source view and its editability.
- **Remote previews remain one bounded complete response. Local content never rides
  that response.** `file/resolve-local` returns the canonical absolute path after
  owner/path resolution; Electron owns bounded content reads and resource lifetime.
  Negotiate `localFileResources` through the central machine protocol binding.
- `maxBinaryBytes` stays pinned to `SESSION_IMAGE_MAX_SIZE_BYTES`. Do not raise these
  budgets without measuring against the real gateway, since a non-404 4xx append
  failure is not retried.
- The `path_not_allowed` message must keep the phrase "File is outside the
  workspace" — the web error surface keys its dedicated presentation off that text
  (`session-file-error-state.tsx`).
- **Reading is wider than writing, on purpose, and preview grants no write
  capability — do not add one here.** Remote preview serves only the allowlisted
  temp/scratch roots, while Electron's same-machine local preview can inspect
  arbitrary paths. `code-collab/save-text` refuses everything outside the session
  workspace (lexical check plus `assertRealPathInsideWorkspace` on the
  symlink-resolved path) and cannot create files at all. The client counterpart: an
  `external: true` result must be marked readonly regardless of the file index, or
  the editor offers a Save the machine is guaranteed to reject and the user loses
  the edit.

Normative contract: `specs/file-preview-v3.md` (private repo). Schemas:
`packages/shared/src/file-preview.ts`.
