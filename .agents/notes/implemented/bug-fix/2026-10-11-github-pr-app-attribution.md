# Preserve GitHub App attribution when creating a PR

Status: implemented
Translation: current

[中文](2026-10-11-github-pr-app-attribution.zh.md)

## Abstract

Native `gh pr create` uses GraphQL; an operator comparison found that it omitted
App provenance even though a GitHub App user token correctly attributed the PR
to the human. REST creation with the same authorization and commit retained the
App provenance. The managed shim now uses REST for explicit noninteractive
creation, then applies metadata with the same selected credential. Native modes
that cannot be translated safely remain available with an attribution warning.

## Decision and boundaries

`gh-shim-script.ts` retains credential/target selection and records parsed options
without rescanning option values. Its embedded `gh-pr-create-script.ts` translates
title, body/body-file (including stdin), head, base, draft and maintainer-edit
settings to native `gh api` REST fields. Labels, assignees, reviewers, milestone
and projects use a subsequent native `gh pr edit` with the same environment.
Raw string fields preserve literal Markdown and avoid file/placeholder expansion.

Missing head can use the current branch only when its local SHA matches the
target repository's published ref. Missing base uses the current branch's
`gh-merge-base` setting or the repository default. Automatic push/fork, fill,
editor, web, template, recovery and attachment workflows stay native. This avoids
reimplementing GitHub CLI's complete workflow or breaking existing scripts.
Explicit title/body/base/pushed-head arguments select REST deterministically.
Machine-native credentials and credential-free help stay unchanged.

After creation starts, every failure stops without identity fallback or replay,
including rejected requests and lost/malformed success responses. Print the PR
URL before applying optional metadata; a metadata failure must tell callers to
edit that PR, never create again. This refines the native-execution portion of
[ordered fallback](../architecture/2026-10-03-github-identity-fallback.md), retaining
its compound-write non-replay boundary. It does not change commit authorship.

GitHub's `/pulls/{number}` response omits `performed_via_github_app`; inspect the
corresponding `/issues/{number}` response. App user tokens preserve human authorship;
installation tokens identify the App bot. UI wording remains GitHub-owned.

## Verification and limits

Generated-shim tests cover literal/boolean fields, body files and stdin, inherited
repository options, defaults, native compatibility, same-identity metadata, dry
run/help and rejected/uncertain/partially completed writes. The 56 shim/runtime/
broker tests, CLI typecheck, production bundle and formatting pass. A separate
native Git transport run passes after clearing inherited managed Git environment.
Broader preview tests cannot bind IPv6 `::1` on the validation host
(`EAFNOSUPPORT`); this is not a green full-suite claim. The initial live REST
versus GraphQL comparison establishes the API choice, not deployment of this patch.
Windows and native interactive workflows are not live-tested by this change.

Effect migration was assessed: this is embedded standalone Node source without
runtime package dependencies. Adding Effect would change helper packaging rather
than resolve the API attribution defect; the existing thin process boundary stays.
