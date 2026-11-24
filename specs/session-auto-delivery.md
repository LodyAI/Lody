# Session auto delivery

Status: draft
Translation: current

[中文](session-auto-delivery.zh.md)

## Scenario

A user and an agent agree on a fix in a conversation. From then on the user wants
the routine to run without them: open the pull request, wait for CI, fix failing
checks, resolve conflicts and, when they choose, merge once checks pass. Today each
step needs a button click or a typed message, and waits between steps are spent
watching CI.

## Decision

Auto delivery is a per-Session automation setting, off by default. It is turned on
mid-conversation, never at Session creation, from three places that share one
setting: the Info Bar's Auto delivery action, the Session menu's automation
settings, and the agent itself through `lody_automation configure` when the user
asks for it in conversation. Turning it on chooses which steps Lody may request:
fix CI, resolve conflicts, and merge after CI passes. Merge is off unless chosen.
The setting covers the Session's current open or draft pull request and turns
itself off when that pull request is merged. A pull request merged or closed before
it was turned on belongs to earlier work, so Lody requests a new one instead. A one-line status stays in the conversation until the
user turns delivery off or, after the merge, dismisses it; either clears it for
every device.

The local Host decides each step from the PR poller's observations of the current
pull request. It sends the agent the same request the matching Info Bar button
sends, after an origin line, through the ordinary automation queue and Session
admission. A request waits until the Session group is idle and is dropped if the
pull request has moved on. The agent performs every GitHub change, including the
merge, with its own `gh` access; the daemon only observes.

## Guarantees

- No request is sent unless the user turned Auto delivery on for this Session;
  merge is requested only if the user chose it.
- Lody requests each repair kind at most three times per enablement and a merge
  at most once per head commit. Exhausted limits, a review or up-to-date branch
  requirement, a closed or draft pull request, a request that pushed no new commit,
  or a merge request that did not merge stop delivery with a visible reason in the
  conversation and a mark on the conversation's sidebar row. A request that failed
  or was cancelled stops delivery until the user turns it on again. A stop caused by
  the pull request's observed state ends only when a later observation changes that
  state, for example after a push or an approval; the limits above still apply.
- A head that reports no check has not passed CI. Lody treats the repository as having
  no CI only when a poll at least five minutes after that head was first seen still
  reports no check.
- Lody never pushes local work. Uncommitted or unpushed changes in the Session's
  workspace stop delivery with a visible reason until they reach the pull request.
- Turning delivery off takes effect after any delivery pass already running, so the
  status line it cleared does not reappear, and withdraws a request not yet sent.
- Session Stop blocks pending requests under the existing rule; only the user
  restores it.
- A Session with pull requests in several repositories, and encrypted workspaces
  (which run no PR poller), are not supported. Encrypted workspaces reject the
  setting rather than accept one that cannot act.

## Open questions

- Encrypted workspace support depends on running PR observation locally there.
- A per-project default and a pull-request explainer option were deferred.

## Evidence

- Implementation: `apps/cli/src/automations/policies/delivery.ts`,
  `apps/cli/src/automations/policies/session.ts`, the automation
  [README](../apps/cli/src/automations/README.md#built-in-session-behavior).
- UI: `packages/components/src/components/sessions/session-auto-delivery.tsx`.
- Rationale: [decision note](../.agents/notes/proposed/feature/2026-11-16-session-auto-delivery.md).
- Validation: synthetic ledger tests in `apps/cli/src/automations/automations.test.ts`
  cover the request sequence, limits, guard and request text, plus a property test that
  checks limits, request preconditions and stop rules over generated observation and
  outcome sequences. No run against a real repository or GitHub account has been made.
