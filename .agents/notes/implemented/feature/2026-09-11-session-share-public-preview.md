# Disclose public conversation titles in link previews

Status: implemented
Translation: pending

## Abstract

A social link preview cannot read the access fragment, so the title must have an
explicit public boundary separate from conversation access. The sharing dialog now
states that link previews publicly display the conversation title, without adding
a confirmation step. The host owns preview rendering and lifecycle enforcement;
the public reader still requires its bearer for conversation and attachment reads.
External services may retain already-fetched previews after revocation.

## Decision and evidence

This extends [live sharing](2026-09-09-session-sharing.md) and preserves the
[dialog layout](2026-09-09-session-share-dialog-and-reader-layout.md). The
[draft spec](../../../../specs/session-sharing.md) describes the new title-only
exception. The notice has English and Chinese translations and stays beside the
existing disclosure; no shared DTO or reader authorization behavior changes.

The host supplies initial metadata and images. It must not add the access secret
to a URL or public projection to make social crawlers work. Reset retains a share
ID, so an old fragment-free page identifies the current public title while old
credentials and image versions are invalid. Hosted acceptance remains outside
this repository. Review: [PR #539](https://github.com/LodyAI/Lody/pull/539).
