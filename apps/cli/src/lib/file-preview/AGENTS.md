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
- `file-preview-path-policy.ts` — the security boundary. Remote `file/preview`
  requests may read only the session workspace root, `os.tmpdir()`,
  `<LodyDataDir>/chats`, and `LODY_FILE_PREVIEW_EXTRA_ROOTS`. The separate
  local-only `file/preview-local` IPC method is the Electron user's explicit
  same-machine read capability and may read any regular file; it is never added
  to the Loro Streams RPC protocol.

## Load-bearing details

- The `.lody` data-dir ROOT is deliberately not an allowed root: it holds
  `credentials.json` and the git credential broker state. Allowlist named
  subdirectories, never their parent.
- Authorization is checked against the **symlink-resolved** target and roots, so a
  link inside the workspace pointing at `~/.ssh/id_rsa` is rejected.
- **Resolution and authorization are separate steps, and only one of them folds
  case.** RESOLUTION finds the real on-disk spelling of a requested name: if no
  candidate spelling exists, the policy walks the path down from the workspace
  root and matches each segment case- and NFC/NFD-insensitively (the same
  `pathSegmentComparisonKey` rule the file index is built with). Each step
  appends either the requested name verbatim or ONE listed entry that folds to
  it, and `.`/`..` are refused, so it cannot climb or invent a segment.
  AUTHORIZATION is unchanged: containment is case-SENSITIVE with no fallback,
  and it runs on the symlink-resolved result of whatever resolution produced.
  Case-folded CONTAINMENT would be unsound on case-sensitive APFS
  (`/Users/x/Data` vs `/Users/x/data` are different dirs); case-folded
  RESOLUTION hands the containment check a real path and grants nothing. Do not
  merge them.
- The two halves of that tolerance are NOT the same claim, and the difference is
  load-bearing: NFC/NFD is a RESTORATION (`code-collab/open-text` resolved it via
  `resolveExistingPathWithoutConflicts`; v3 dropped it and files that had always
  opened stopped opening). Letter case is NEW — `open-text` matches on
  `entry.name === segment` then NFC-equality, so `readme.md` never found
  `README.md` there either. Consequence to keep in mind: **preview reads
  case-tolerantly, writes stay case-exact.** `save-text`/`refresh-text` still go
  through the case-intolerant resolver, which is survivable only because the
  client adopts the machine's reported `path` as the file identity.
- Ambiguity declines, it does not guess: more than one entry folding to the
  requested spelling returns no match. The byte-identical name is probed first,
  so reaching the fold branch means no spelling is unambiguously right.
- The verbatim request is tried before the trimmed one: `" notes.md"` is a real
  filename, so trimming first made it permanently unopenable.
- Missing-path classification requires EVERY candidate spelling to be inside an
  allowed root (`every`, never `some`). With `some`, a request like
  `" /etc/passwd"` keeps its leading space in the verbatim candidate, which then
  resolves under the workspace and vouches for the trimmed candidate that
  escaped — turning `file_not_found` vs `path_not_allowed` into an existence
  oracle for the whole filesystem. Regression test:
  "does not turn not-found vs not-allowed into an existence probe past the
  boundary".
- The fold rule is unit-tested through an injected `FilePreviewDirectoryReader`
  (`file-preview-path-policy.test.ts`), not only against the real filesystem.
  On a case-insensitive volume — the macOS default, and this repo gates on a
  LOCAL check — the walk is unreachable through the public entry point, so
  fs-backed tests alone leave it with zero executed coverage.
- A missing target has no realpath, so its classification compares against BOTH the
  resolved and unresolved roots — roots are routinely reached through a symlink
  (macOS `os.tmpdir()` is `/var/folders/…` living at `/private/var/folders/…`), and
  resolved-only comparison reported every deleted temp file as "outside the
  workspace". That step only picks the error code; it never grants a read. It still
  reports `file_not_found` only inside an allowed root, so the two codes cannot be
  used as an existence probe past the boundary.
- Oversize is refused, never truncated — half a PNG is a corrupt file, and half a
  JSON is a syntax error. The read takes one byte past the limit so a file that grew
  between `stat` and `read` is caught.
- Binary detection is content-first (NUL sniff, then a failed UTF-8 decode), but a
  known RASTER image extension forces the binary path: an image whose header happens
  to avoid NUL bytes would otherwise ship as mojibake text. Use `isBinaryImagePath`,
  NOT `getImageMimeTypeForPath` — the latter also matches SVG, which is XML text and
  must stay on the text path to keep its source view and its editability.
- `maxBinaryBytes` is pinned to `SESSION_IMAGE_MAX_SIZE_BYTES` because that is the
  only budget for this payload shape (base64 image bytes in one Machine RPC
  response) already proven in production, via `local-project/control` image reads.
  The gateway's real per-append ceiling is not asserted anywhere in this repo — do
  not raise these budgets without measuring against the real gateway, since a
  non-404 4xx append failure is not retried.
- The `path_not_allowed` message must keep the phrase "File is outside the
  workspace" — the web error surface keys its dedicated presentation off that text
  (`session-file-error-state.tsx`), because the generic `permission-denied` copy
  ("Access denied") misdescribes a policy rejection as a filesystem one.
- **Reading is wider than writing, on purpose.** Remote preview serves only the
  allowlisted temp/scratch roots, while Electron's same-machine local preview can
  inspect arbitrary paths. `code-collab/save-text` refuses everything outside the
  session workspace (lexical check plus `assertRealPathInsideWorkspace` on the
  symlink-resolved path) and cannot create files at all. Preview grants no write
  capability — do not add one here. The client counterpart: an `external: true`
  result must be marked readonly regardless of the file index, or the editor offers
  a Save the machine is guaranteed to reject and the user loses the edit.

Normative contract: `specs/file-preview-v3.md` (private repo). Schemas:
`packages/shared/src/file-preview.ts`.
