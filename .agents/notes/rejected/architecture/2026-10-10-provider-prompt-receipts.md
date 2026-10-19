# Keep agent message idempotency out of model-provider protocols

Status: rejected
Translation: current

[中文](2026-10-10-provider-prompt-receipts.zh.md)

## Abstract

The duplication request concerns completion Delivery inside Lody. The follow-up
incorrectly expanded it into durable native model admission through a new ACP
receipt protocol for Codex and Claude. The user clarified the boundary; those
uncommitted client/adapter/protocol changes were withdrawn. Shared message
orchestration owns persistence and consumption acknowledgement for every runtime.

## Correction and decision

Earlier “provider” wording confused message delivery with native model execution.
The [local fix](../../implemented/bug-fix/2026-10-10-agent-message-idempotency.md)
uses stable identities, SQLite claims, consumption settlement and retired ids.
Duplicate notifications reconcile the same Delivery; failed settlement writes
retry settlement, never execution. Generic execution recovery must not resubmit
a Delivery after its durable start fence, without changing ACP clients or adapters.
The start/submit crash gap remains uncertain; native exactly-once successful
execution is a separate guarantee outside this request.

The withdrawn design used immutable filesystem claims, cached prompt responses
and negotiated ACP metadata/query methods. Its synthetic tests passed, but it
coupled the fix to adapter releases and could not recover lost streamed output.
No receipt capability, Node runtime export, ledger or new dependency is retained.

The [Effect guide](../../../docs/cli-effect-ts.md) separates lifecycle from durable
state. Existing Effect recovery applies the no-replay policy; SQLite owns durable
claims and acknowledgements. No broad coordinator rewrite is needed.

## Verification

Withdrawal checks cover the four owning CLI execution/coordinator/store/model
suites, typechecking, scoped formatting, diff and documentation checks. ACP
submodules and client sources have no task diff. No paid native-model or desktop
acceptance or native-runtime deployment is claimed.
