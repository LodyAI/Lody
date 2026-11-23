# Read both user-level Git identity files

Status: implemented
Translation: current
Pull request: [#1517](https://github.com/LodyAI/Lody/pull/1517)

[中文](2026-10-12-xdg-git-identity.zh.md)

## Abstract

An existing `~/.gitconfig` can hide an identity stored only in XDG configuration
when the host probe uses `git config --global`. Read the two user-level files in
Git's precedence order through an isolated include file, leaving parsing and
conditional includes to Git. Repository, system and command-level identity remain
outside this lookup. This addresses only the local-config part of [#1451](https://github.com/LodyAI/Lody/issues/1451).

## Decision and limits

A private temporary directory owns the include file and is removed in `finally`.
Unlike stdin, this file can be reread for `hasconfig` conditions. The extra include
consumes one level of Git's include-depth limit. Explicit `GIT_CONFIG_GLOBAL` and
an absent or empty `HOME` retain the native global lookup. Author/committer environment
precedence and the five-second command timeout are unchanged.

The synchronous caller and shared process facade remain in place; migrating the
Session lifecycle would exceed this fix. Owner/profile policy and credential
selection are unchanged, including the separate [policy deadline](2026-10-11-git-identity-preflight-deadline.md).

## Verification

Real Git fixtures cover XDG/home precedence, includes, explicit overrides,
environment identity and exclusion of repository/command identity. Verification
results and platform limits are recorded in the pull request.
