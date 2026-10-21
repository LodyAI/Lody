# Windows Inbox resource containment, deferred stage 2

Date: 2026-10-21
Status: proposed
Translation: current
PR: [#1778](https://github.com/LodyAI/Lody/pull/1778)

[中文](2026-10-21-windows-inbox-containment.zh.md)

## Abstract

Windows startup recovery cannot safely infer whole-tree release from recorded root
PIDs: descendants may outlive their parent and PID reuse changes identity. Stage 2
proposes acquisition-time Windows Job Object or equivalent controlled-container
ownership, with durable generation identities and verifiable whole-container exit.
It is not implemented by the [manual recovery change](../../implemented/bug-fix/2026-10-21-manual-inbox-recovery.md).
Legacy or uncertain records must continue to use the explicit offline flow.

## Revisit trigger and proposed boundary

Revisit when recurring Windows stale ownership or repeated manual-recovery friction
justifies native containment work. Do not remove the Windows fail-closed guard as a
shortcut. The [Windows Job Object contract](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
describes process association, child inheritance, breakaway and termination behavior;
using a Job name or observing a parent exit is not itself proof of safe recovery.

- Establish container ownership before arbitrary process execution, including
  partial acquisition rollback. No silent unowned launch or permitted breakaway
  may escape the proof boundary; reject or explicitly retain uncertainty.
- Own the actual Session sandbox lifecycle. ACP processes may be reused across
  turns, so one Job per prompt that kills a reusable ACP is not equivalent.
  Relate execution journals to the correct sandbox generation and all acquisitions.
- Persist generation/resource identities that can be verified after restart,
  acquisition-complete evidence, and any retained termination failures. PIDs alone
  or a cached 'complete' flag are insufficient.
- Prove actual whole-container/tree exit, including descendants whose root exited.
  Permission errors, unavailable probes and interrupted journaling remain unknown.
  Recovery rechecks exact ownership/snapshot under SQLite CAS before clearing it.
- Keep legacy records on manual recovery. Never replay unknown submissions or
  infer provider success from a resource-release receipt.

## Acceptance before shipping

Native Windows tests must exercise root exit with surviving descendants, nested
children, breakaway attempts, suspended/spawn-time acquisition races, PID reuse,
reused ACP across turns, interrupted journaling, permission errors, failed cleanup,
restart and changed ownership during recovery. Assert both safety and availability:
confirmed release permits successors, uncertainty retains ownership, independent
cleanup still completes, and already submitted/unknown input never replays.
Design review must identify supported Windows versions and how external requests
outside the process container retain their own release evidence.
