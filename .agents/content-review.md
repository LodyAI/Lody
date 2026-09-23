# SHA review for selected content

Register important documents and supporting code after humans confirm the scope.
Ordinary references need no hash. The tool records content versions and review
conclusions; it cannot prove those conclusions correct or grant human Spec approval.

## Commands

```sh
pnpm run docs status
pnpm run docs check
pnpm run docs check --base <PR-base-commit>
pnpm run docs diff --topic specs/example
pnpm run docs confirm --topic specs/example --reason "Why the contract still holds or how it changed" --evidence "Requirements, tests, or review evidence checked"
```

Status, check, and diff are read-only. Only confirm updates the named record.
Check fails for stale, missing, or unconfirmed registered topics, but not pending
translation. With no registered topics, a passing check means only that document
checks passed. Use `--base` in PRs to detect deletion of an entire record; without
it, only the current tree is checked.

## Records beside their documents

This conceptual example is `specs/example.anchors.json`; it does not enable protection:

```json
{
  "version": 1,
  "rationale": "Drift in this guarantee could affect user data",
  "scopeReview": null,
  "documents": ["specs/example.md"],
  "sources": ["packages/example/src/contract.ts"],
  "watch": ["packages/example/src"]
}
```

Replace the owner's `.md` or `.zh.md` suffix with `.anchors.json`. A bilingual pair
shares one record. The tool discovers records under `specs/`, `.agents/docs/`,
and `.agents/notes/`. The topic is the repository-relative path without
`.anchors.json`;
`documents` must include its same-named owner.

Agents propose the scope. After human confirmation, set `scopeReview` to a traceable
approval reference: an HTTP(S) URL, `PR #123`, or a full 40/64-character commit hash. Unknown fields are rejected, including nested baseline and retirement fields. A well-formed reference is not proof that approval actually happened.

- `documents` tracks complete document contents.
- `sources` lists files with this topic's code markers; only their marked declarations
  determine freshness.
- `watch` tracks file additions and removals, not changes to every file's contents.
  It can prompt scope review when new implementation appears. Symlinks, build output,
  dependency directories, and separate submodule workspaces are excluded from both
  working-tree and committed inventories. Explicit source paths still reject symlinks.

Keep scope small and explicit. References do not propagate protection recursively.
Explain changes to protection relationships. Checks with a base reject deletion of
an entire record. Retire a topic by retaining its record as described below.

Confirm requires protected documents, source files, and watched file membership to
match current HEAD, so the recorded revision and paths are recoverable at registration.
Commit reviewed content first, then confirm and commit the metadata; no push is required.
Missing files, uncommitted changes, or unconfirmed scope prevent confirmation.

The baseline stores full document Git blob hashes, full code-block SHA-256 hashes,
a scope fingerprint, revision, file inventory, reason, and evidence. Source-file blob
hashes support historical diff recovery only; they do not determine block freshness.
The record does not hash itself. Short hashes are for display only.

## Reviewing changes

Inspect the diff and check the relevant promises, responsibilities, and diagrams.
Update the document or explain why it still holds. Changed Spec intent needs human
approval; unrelated implementation changes need not rewrite prose, trigger translation,
or renew intent approval. Identical protected content after a merge needs no new review
merely because commits changed. Git timestamps can help prioritize audits only.

Historical diff reads the stored blob directly; `revision` is provenance only.
The command compares that content with the working tree using temporary files and
neither writes Git objects nor refreshes the baseline. Squash/rebase does not break
diff when the blob remains available. A shallow clone includes blobs in its fetched
trees, but may lack older versions; missing blobs produce an explicit error naming
the hash. Obtain public history containing that content before reviewing. Do not
interpret a missing object as no change, or update the baseline to hide it.
CI fetches only the PR base commit for deleted-record detection, not all history.

Documents are checked as whole files. Code hashes ignore trailing whitespace, and
changes to other declarations in the same file do not invalidate a marked block.
Functions called outside that block are not automatically protected; mark critical
dependencies separately.

## Code markers and reciprocal references

Following AfterRay's marker-before-declaration model, the example record lists
`packages/example/src/contract.ts`, which contains:

```ts
// @dec:specs/example
export function save() {
  // The complete declaration is protected.
  persist();
}
```

The marker uses the same repository-relative topic path as `--topic`, avoiding
collisions between same-named documents in different directories. The adjacent
`.anchors.json` is the document's dependency list; do not duplicate it as an
Anchors list in the prose.

The tool scans JS/TS sources under `apps/` and `packages/`, including TSX, JSX,
MJS, CJS, MTS, and CTS. Every source marker must resolve to a record that lists
its file in `sources`; every listed source must contain a matching marker.
Missing markers, deleted declarations, unconfirmed new declarations, invalid syntax,
and duplicate signatures within one file/topic fail checks. Markers are standalone
`// @dec:...` comments, not text inside strings.

The repository's TypeScript parser identifies the complete following statement or
member declaration, including functions, variables, classes, and methods. Unlike
brace counting, parsing handles types and template strings without truncating the
block. Keys are `file path::first declaration line`; values store full SHA-256 hashes.
Rust/Swift anchors and document-section hashes are not supported. Document-to-document
references can use `documents` for file-level protection.

After review, confirm the specific topic. There is no bulk refresh. Code drift requires
review of the relevant declaration; it does not automatically revoke human Spec approval.
Changed intent or guarantees require renewed approval.

## Retiring protection

Keep the record, scope, and previous baseline, and add reviewed retirement metadata:

```json
"retired": {
  "date": "2026-09-06",
  "reason": "The protected contract was removed; replacement is documented elsewhere",
  "scopeReview": "PR #123"
}
```

The date must be a real YYYY-MM-DD date; reason and a traceable human review reference
are required. Remove source markers pointing to the retired topic in the same change.
Its status becomes `retired`, freshness is no longer checked, and confirm refuses to
refresh it. Live markers cannot point at retired topics. The retained record preserves
why protection ended even when its documents or sources disappear. `check --base`
still rejects deletion of the record itself, including retired records. A document
move can leave a retired record at its old path and register protection at the new one.

## Other checks and limits

Metadata checks cover active Specs and notes: lifecycle/type, a nonempty opening
Abstract (or 摘要), translation-counterpart existence when marked current, and equal
`Status:` values when both languages exist. They do not judge translation meaning,
abstract quality, diagram accuracy, or genuine human approval.

A separate pass checks local inline and reference-definition link targets in all
tracked and untracked non-ignored repository Markdown, including root/contributor
hubs and archived notes. Dependency/build output is normally ignored by Git; submodule
contents belong to their own repository. Symlink aliases are skipped in favor of their
canonical files. Heading fragments are not validated. Archived metadata and prose
are historical, but broken outbound links are reported and may be repaired without
changing the historical decision. Every canonical `AGENTS.md` must be under 8192 bytes.

One malformed topic produces `{ topic, status: "error", message }` alongside the
healthy topics and document queues. Source parsing errors appear in the shared error
list instead of removing the report. Check exits unsuccessfully if any topic or other
check fails; status retains the report for triage. There is no scheduled audit,
external-service validation, or automatic translation.

## Sources of the design

DSH keeps bilingual blob hashes in adjacent `foo.i18n.yaml` files and separates
maintenance guidance by responsibility. AfterRay uses `@dec:` markers and
`.anchors.json` for code-block review. Lody adapts those relationships and hash
granularity with a TS parser, path-based topics, full hashes, and scoped confirmation.
Asynchronous translation, human Spec approval, and selective protection follow Lody's
own policy.
