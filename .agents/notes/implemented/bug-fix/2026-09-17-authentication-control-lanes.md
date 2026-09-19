# Keep authentication input runnable during login

Status: implemented
Translation: current

[中文](2026-09-17-authentication-control-lanes.zh.md)

## Abstract

Local ACP login requests waited for user input while holding the same queue lane as that input. Selecting a Google Antigravity login method therefore timed out without advancing authentication. Authentication starts now have a separate lane from their input and cancellation requests, scoped to the machine and authentication request. Deterministic queue tests confirm the follow-up actions run while login remains pending; they do not prove completion of Google consent.

## Decision and evidence

[Issue #505](https://github.com/LodyAI/Lody/issues/505) reports a visible method chooser followed by an input-submission error. Unlike the missing authentication support addressed in [#208](https://github.com/LodyAI/Lody/pull/208), the local dispatch path already supports the protocol operations.

`MachineRuntime.dispatchLocalMessageForResponse` sends both login and follow-up actions through `MessageProcessor`. Previously they all used its null key, which `ConcurrentQueue` maps to one default serial chain. The login handler waits for input, so that chain cannot reach the handler that supplies it. The same dependency affects authorization codes and cancellation.

Keep the queue's existing default semantics and session ordering. Give each authentication request a start lane and a follow-up lane; input and cancellation for that request remain ordered with one another. Changing every null-key operation to run independently would change unrelated machine operations. Increasing the renderer timeout would retain the dependency cycle.

## Verification

The existing message processor suite includes fake-timer cases for `submit-input`, `submit-code`, and `cancel`. All three fail on the previous code and pass with separate lanes, alongside the existing session ordering checks. No real Google account or browser consent was used. The global concurrent-work limit is unchanged.
