# Human-reviewed Specs and incremental document maintenance

Status: proposed
Translation: current

English | [中文](2026-09-05-human-reviewed-spec-maintenance.zh.md)

## Abstract

Documentation can drift as code changes, while requiring records and translations
for every small fix burdens contributors. This proposal uses human-reviewed Specs
to express intent, Agent Notes to preserve important trade-offs, and SHA checks on
critical code blocks to prompt focused review. Routine fixes need no note and
translations may follow later, reducing everyday work while leaving accuracy to
human judgment. The maintenance rules and checking tools have an initial implementation;
the overall proposal remains under review and no formal protection scope is registered.

## Problem

Contributors need to understand system intent and important design rationale, but
documentation can drift as implementation changes. Requiring a complete work record,
both languages, and file hashes for every small edit adds unnecessary work.

## Decisions and findings

Notes are organized by lifecycle and decision type. This process proposal remains
under review; routine small fixes do not require a note.

This change introduces [public document maintenance](../../../README.md), starting
with the [communication architecture draft (Chinese)](../../../../specs/communication-architecture.zh.md).
Humans review Spec intent; agents provide implementation evidence and open questions.
Important work gets a note, while routine local fixes are exempt. Translation is
asynchronous. Selected documents and critical code receive scoped SHA protection;
ordinary references need no hash. Starting, finishing, and scoped audit procedures
are supported by status reporting, classification/link checks, and targeted SHA tools.
Formal protection scopes and baselines remain unregistered; there is no bulk migration.

Root `specs/` holds publicly shareable client behavior, architecture, and protocol
intent. Maintenance guidance lives in `.agents/`, cross-module explanation in
`.agents/docs/`, and a single directory's implementation navigation in the owning
module's README. There is no root `docs/` directory: `site-docs/` already owns the
user-facing documentation at `lody.ai/docs`, so a second root `docs/` would read as
product documentation to anyone browsing the repository, and `docs/` therefore stays
a closed path in the public-boundary check. Public-boundary checks continue to reject
private paths, internal absolute paths, and deployment information. The communication
draft distinguishes repository evidence from maintainer-confirmed cloud intent.

Invariants remain in the nearest `AGENTS.md`. Agents deriving risks from history first
check existing rules, distinguish a missing constraint from an implementation violation,
and propose necessary changes. Notes record findings and rationale without duplicating
invariants.

## Alternatives and trade-offs

- **Bind every reference to a SHA and require review:** unrelated file edits and metadata
  conflicts across branches increase work. Use small, human-confirmed protection scopes,
  full hashes with shortened display only, and explicit confirmation after targeted review.
  AfterRay-style declaration anchors avoid invalidation from unrelated declarations in
  the same file. Documents retain file-level review costs without repository-wide cascades.
- **Use last-edit time as evidence of correctness:** timestamps can prioritize audits;
  fixing a typo does not establish that implementation was reviewed.
- **Restate all code precisely in Specs:** this obscures human intent and increases reading
  burden. Prefer concise scenarios, module hierarchy, and important guarantees. Omit
  incidental details and identify unknowns explicitly.
- **Require a note for every behavior change and bilingual completion before merging:**
  this burdens routine fixes and community contributors. Record decisions by importance
  and translate later, while making translation debt visible.
- **Create a separate invariant-candidate system:** this duplicates existing `AGENTS.md`
  ownership. Keep the existing mechanism and feed evidence of risk into it.

## Tool choices

Baselines record committed content; diff recovers it directly from stored blob hashes.
The revision is provenance only. Commit code/documents first, then the confirmation record.
Squash/rebase does not break diff when the blob remains available; shallow clones
may still need history containing older blobs. Maintenance steps live directly in
`.agents/README.md`, with SHA details linked separately. These are repository conventions,
not a skill requiring selection or invocation. Adjacent `.anchors.json` records borrow
DSH's sidecar organization and extend it to selected Spec/code review. Independent records
and derived status avoid global-index conflicts. No product module is claimed protected
before its scope is registered.

## Review and validation

The change awaits full human review, and the communication Spec is not approved.
Rules and drafts are not evidence of verified runtime behavior. Local document links,
instruction-file sizes, symlinks, and diff whitespace have been checked; these do not
establish product correctness. The public-boundary check failed because this checkout's
ACP submodules were uninitialized and existing workspace dependencies could not resolve;
it reported no new documentation violations. Product tests, backends, and live behavior
were not validated.

PR: not created; add the link after creation. This example note now has both languages;
remaining document translations and repository-wide audits are still pending. Tool tests
use synthetic Git repositories and do not replace product validation. The PR template
embeds the full ShowMe guidance, so outside contributors need no skill installation.

## Code-block review choices

Borrow AfterRay's source `@dec:` markers, adjacent `.anchors.json`, and reciprocal
reference checks. Lody uses the TypeScript parser to select complete declarations,
avoiding brace-counting errors around TS return types, template strings, or TSX.
Repository-relative document paths identify topics without slug collisions. Dependency
lists live only in sidecars, with no duplicated Anchors list in prose. Hashes retain
full values and ignore only code trailing whitespace. Calls outside a marked block do
not automatically extend protection; critical dependencies must be selected explicitly.

Keep per-topic reason/evidence confirmation and committed baselines rather than
AfterRay's global `--write`. Current support covers JS/TS declarations and whole documents,
not Rust/Swift anchors or document sections. No formal product topic is registered.
Synthetic tests cover changes inside and outside blocks, missing reciprocal references,
marker removal, TSX/template strings, and invalid syntax.

## End-to-end workflow verification

A synthetic checkout exercises the real CLI from initial unreviewed status through
confirmation, code drift, read-only diff, and reconfirmation. Spec status remains
draft throughout. Verification also exposed and fixed a missing opening-abstract
check and omitted source diffs when only some declarations were removed. These
checks validate maintenance tooling, not product behavior or human review quality.

## Long-term accumulation safeguards

Watch inventories exclude symlinks consistently. Blob-based diff removes the dependency
on PR commit reachability. Topic errors remain visible beside healthy records. The gate
checks repository-wide Markdown links (including archives), bilingual Status agreement,
and the 8 KiB instruction limit. Strict fields and traceable scope references catch
configuration mistakes. Reviewed retirement retains the record while ending freshness
checks, and requires removing its live code markers.

The expanded size gate exposes 17 existing oversized AGENTS.md files in this checkout.
These are pre-existing migration work, not silently exempted. The gate will remain red
until they are reduced or maintainers explicitly revise the policy. Product topics
remain unregistered. PR-template changes belong to the other concurrent session.
