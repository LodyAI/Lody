# No-PID spawn failures preserve resource identity

Status: implemented
Translation: current

[中文](2026-10-17-no-pid-spawn-resource-identity.zh.md)

## Abstract

A missing optional executable such as `gh` made Session resource identity
permanently incomplete even though no process was created. PR detection caught
the command error, but Inbox finalization retained the turn and blocked later
inputs. The sandbox now recognizes the exact child error emitted without a PID
and rejects the command without introducing resource uncertainty. Other failures
and existing uncertainty remain blocking; recovery scheduling is unchanged.

## Decision and boundary

The sandbox observes Node's child error synchronously with process acquisition.
Only that error, unwrapped from the shared process failure, qualifies when the
child has no PID. An errno alone cannot distinguish spawn failure from journal,
configuration or cleanup failure. The pending-spawn counter still fences the
journal until acquisition settles, including concurrent starts. We never clear
an earlier uncertainty flag.

The Session remains the resource owner; acquired processes, cancellation,
termination and successor admission retain the existing
[Inbox contract](../architecture/2026-10-12-operation-inbox.md). Failed journal
writes and unresolved release failures still require the retained recovery owner.
This corrects acquisition evidence without changing physical release guarantees.
Installing `gh` merely avoids one trigger. No credential/PATH change or automatic
recovery mechanism is needed for this fix.

The existing native process containers already own acquisition and cleanup. This
small correction belongs in their legacy Session journal adapter; a larger native
migration would extend into Session consumers and is deferred.

## Verification

The owning sandbox suite covers no-PID ENOENT/EACCES with a live agent, fresh
observers, concurrent acquisitions, and preservation of prior journal uncertainty.
The new success assertions fail against the original adapter. Fixtures use the
shared fake process table and explicit configuration gates, without real sleeps.
All 39 sandbox/container tests pass, as do the process and Inbox boundary guards,
formatting and targeted lint (two existing declaration-order warnings). This
checkout has no installed dependencies: validation reused an existing Effect
4.0.2 environment with the current shared process sources explicitly mapped.
It is not a full frozen-install/typecheck/build result. Documentation checking
still reports existing missing submodule links, with no errors in this note pair.
