# Community PR size and team identity

Status: implemented
Translation: current

English | [中文](2026-09-07-community-pr-size.zh.md)

## Abstract

Unsolicited community pull requests that rewrite large parts of Lody are expensive to review and can silently break invariants. Community PRs are therefore capped at 1000 changed lines unless a maintainer assigned the linked Issue. Agents decide team vs community with one check against a short GitHub-login roster or an explicit user claim, so Lody team sessions do not spend tokens re-deriving identity.

## Problem

Enthusiastic contributors, often with little open-source experience and often using coding agents, opened large patches as gifts. Reviewing them well enough to protect local/cloud, catalog, and protocol invariants was not realistic, and rejecting them without a public rule looked arbitrary.

The same agent-facing files are read by Lody team sessions. A rule that said "community contributors must..." without a cheap identity test caused team agents to treat maintainers as outsiders and burn tokens on the distinction.

## Decision

- Binding agent rule: root `AGENTS.md` (entry) and `.github/AGENTS.md` (PR path).
- Human explanation and conventions: `CONTRIBUTING.md`.
- Enforcement: fork PRs over 1000 additions plus deletions need a maintainer assignment on the linked Issue; over 200 without an Issue reference still fail as before. Same-repository branches remain `internal`.

Identity is one-shot, then stop:

1. The user says they are Lody team, or
2. GitHub login is `zxch3n`, `Leeeon233`, or `wibus-wee` (also git `user.name` Zixuan Chen, Leon Zhao, or Wibus Wu).

Otherwise community. Do not probe remotes, org APIs, or `author_association`.

The roster is the write/admin collaborators on `LodyAI/Lody` as of 2026-09-07. Unknown logins default to community until the list is updated. Team members should push same-repository branches; a fork stays external even for a team login, matching existing PR policy.

## Alternatives rejected

- **No numeric cap, review case by case:** already failed; the cost is paid before a maintainer can say no.
- **Classify from `author_association` or origin URL:** forks from owners stay external by design; a clone of `LodyAI/Lody` is a common community starting point, so origin alone false-positives.
- **Live org-member API as the agent check:** extra calls, token spend, and flaky auth in contributor environments.
- **Emails in the public roster:** unnecessary personal data; GitHub logins are already public.

## Limits

The 1000-line figure is GitHub additions plus deletions, including lockfiles. Assignment is an explicit maintainer action, like `status:pr-policy-bypass`. The roster will drift when membership changes; conservative default is community.
