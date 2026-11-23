# Bug reports

Parent `AGENTS.md` files apply. `CLAUDE.md` is a symlink; edit `AGENTS.md` only.

- Report creation and the optional client attachment have separate success states.
  Once created, show the report ID and allow dismissal, including while an
  attachment is uploading or retrying. An attachment failure never undoes creation.
- `bug-report-dialog-container.tsx` owns the attempt and frozen retry snapshot.
  Close, account/workspace change and unmount cancel and retire the attempt; a
  late response must not replace a newer report. Retry only the same report ID.
- `../../lib/bug-report-api.ts` bounds the complete attachment request, including
  response-body reads, and settles cancellation even if an adapter ignores abort.
- Only a workspace whose admission is confirmed ordinary (plaintext v1 or legacy
  unclassified) offers machine logs and client diagnostics. Encrypted and still-unknown
  workspaces file the description and build information only, because the diagnostics
  endpoint refuses encrypted workspaces by design; their success state shows no
  diagnostics status.
- Use the real dialog and API in lifecycle tests; keep only network and workspace
  inputs synthetic. Use fake clocks for deadline tests.
