# Direct folder selection and standalone project display

Status: implemented
Translation: current

[中文](2026-10-26-project-direct-folder-selection.zh.md)

## Abstract

Creating a multi-folder Project no longer requires adding each directory as a
standalone project first. The editor prepares folders without writes, registers
or reuses them when saving, and keeps their standalone visibility separate from
membership. Explicitly adding the same folder enables its existing entry; removing
that entry preserves directories, memberships and conversations. Registration and
Project persistence remain separate writes, so failed saves retain reusable
registrations rather than rolling back shared state.

## Decision and boundaries

The user requested implementation of the direct-selection approach recorded in the
[multi-repository Spec](../../../../specs/multi-repo-projects.md#direct-folder-selection-and-standalone-visibility).
This completes the creation/display decision from the initial research; it does
not approve unrelated portions of that draft Spec or the earlier
[multi-repository proposal](../../proposed/architecture/2026-10-16-multi-repo-projects.md).

- Reuse the directory browser, adding folders one at a time to one draft. The
  direct entry targets the current owned machine. Existing-source selection stays
  available, including for platforms without a local machine.
- `projectFolderSelection` v1 gates opt-in `prepare-add` inspection. Ordinary
  requests retain their old response shape. Reuse the daemon's read-only member
  probe for Git identity and submodules; do not infer Git from parent directories.
- Draft paths and inspection results never enter Project definitions. Save
  revalidates canonical identity and Git/repository identity, registers every
  selected folder, then writes the complete Project. No rollback deletes a
  registration another Project or session may already use. Selection dismissal
  invalidates late responses; save admission prevents duplicate submissions.
- `LocalProjectMeta.standaloneVisible` defaults to true when absent. Display lists
  filter false; accessible registrations, repository-copy lookup and session
  sharing retain them. Hidden display is not authorization. Local transactional
  updates preserve history and other fields; daemon refreshes preserve current
  display state. Concurrent distributed writes retain existing Flock convergence.
- Explicit UI/CLI Add promotes the same identity. UI removal hides the standalone
  entry without archiving sessions or cleaning worktrees. Legacy queued removal
  commands and their result notifications retain their earlier semantics; no new
  CLI/MCP removal API or registration garbage collector is introduced.
- GitHub-backed selections retain portable repository semantics. Ordinary folders
  remain machine-bound and visibly warn that originals are edited in place.
  Existing entries stay visible when reused as members.

Keeping the old picker alone preserved an unnecessary prerequisite. Putting paths
straight into member definitions would replace machine resolution and portability
contracts. The chosen approach changes presentation while retaining those contracts.
Older UI versions may still display all registrations; this flag is not a security
boundary. A known remote registration missing from the local replica reports an
unavailable error instead of overwriting unobserved history.

## Implementation and validation

Owning files: `local-project-import.ts`, `project-group-form.ts`,
`project-group-editor-dialog.tsx`, `visible-local-project-index.ts`, and
`apps/cli/src/lib/local-project-meta.ts`. The renderer persists daemon-observed
GitHub identity so a newly registered copy is immediately eligible for a portable
Project. The existing Promise entrypoints and native probe facade are reused;
no lifecycle migration or additional process owner was introduced.

Behavioral suites cover preparation without writes, promotion/reuse, preserved
history, malformed rows, path/repository changes, partial-save retry, hidden copy
availability and daemon refreshes. Playwright exercises real form/picker components
with a synthetic filesystem, including duplicate selection, cancellation and the
in-place warning. Screenshots use the same Storybook flow; they do not establish
an end-to-end agent session or native OS-picker run. Component and shared suites, relevant CLI tests, typechecking, lint, boundary
checks and documentation checks pass. Full `pnpm check` is not green: the
unchanged recursive SSH transport test fails with `context_unreadable`, also
reproduced in isolation; its early test-run exit leaves later package suites
unverified. This change does not modify Git credential handling.
