# Codex GitHub code review

Codex GitHub code review reads `## Code Review Rules` in `AGENTS.md` files.
Repository-wide rules live in the root file. This document restates that bar
so humans and nested guidance stay aligned.

Report only P0 and P1 findings. Security outranks completeness. If the pull
request solves the linked Issue and no P0/P1 remains, react 👍 and stop.

## Severity

- **P0:** exploitable security, secret leak, auth or capability bypass, data
  loss, or a broken public/cloud/local repository boundary.
- **P1:** likely shipped user-facing breakage, or a durable catalog/session
  contract violation that will ship.
- Do not report P2+, style, nits, formatting, or lint. Those belong in CI.

## Security first

Flag secrets in source or fixtures, captured user/agent transcripts, untrusted
input treated as trusted, permission or capability bypass, local/cloud boundary
leaks, and Agent Role or MCP catalog rows that store or display secrets.
Follow `SECURITY.md`; do not request public disclosure of a vulnerability.

## Do not flag

- Extreme or hypothetical edge cases of an otherwise working solution.
- Missing tests for those edge cases.
- Alternative designs, extra coverage, or completeness once the Issue is met.
- Duplication or "could extract this" unless this diff adds more than 100
  lines of near-identical code.

## Disposition

When the PR actually solves the linked Issue and the review found no P0/P1,
approve with 👍. Do not withhold that signal for polish, theoretical risk, or
incomplete extra scope.
