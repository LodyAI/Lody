# Personal-device client host

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Read the [custody Spec](../../specs/e2ee/client-custody.md), [core rules](../e2ee-core/AGENTS.md)
and [platform rules](../platform/AGENTS.md) before changing these boundaries.

- This package composes the existing core, portable curve capabilities and injected
  storage/custody/remote ports. It imports no Node, Electron, filesystem or SQLite API.
  Keep desktop adapters as consumers of shared logic, rather than copying a second service tree.
- Capture account/workspace/pinned genesis and the exact local incarnation before
  any work. An offer arrives independently; a relay cannot choose its pins. Login,
  custody readiness and receipts never authorize admission or key reception.
- Retain first request, approval and claim originals before network; reverify keys,
  credentials and approval on reopen. Never re-sign or switch a session on unknown
  results. Only independently verified current ledger admission permits receiving keys.
- Optional history qualification retains signed pages under the same identity/session,
  rechecks the original snapshot and preserves its origin and rollback pin. A cached
  proof or checksum is never authority; missing raw bodies do not imply a fork.
- Keep genuine ledger and historical reads usable under independent key/repair failures.
  New seals prefer the installed current epoch inside core, never a cached hint.
  Only a genuinely missing key permits retained-published-key writes within core’s
  durable fifteen-minute observation budget; exhaustion fails for retry. Sealed old frames remain usable. Rotation advice alone never blocks sends, and malformed remote input never retires
  a healthy local store. No plaintext, fresh namespace or memory-only fallback.
- Enter custody writer ownership before allocating identity and through actual
  native settlement, then release before network. Only the same fiber may reenter.
  Close fences new work, aborts network waiters and drains actual borrowed crypto;
  late completion cannot revive closed or replaced owners. Acquire returned
  secret buffers together with wipe registration through acquireRelease or
  acquireUseRelease; native settlement alone does not establish cleanup ownership.
  Plaintext copies made before executor entry require immediate cleanup ownership:
  release on rejection before entry, then transfer exclusively to the entered program
  until actual native settlement. Reject delayed execution of a released copy.
- Replacement verifies new desktop approval, drains the old incarnation and uses
  the approved atomic archive/current switch. Preserve old pins, wrappers and
  journals. Logout, close and ordinary cache cleanup never delete identity.
- RPC exposes the existing closed product methods and exact original retries,
  never private keys, credentials or generic signing to product callers. Real
  injected implementations are required; no empty handler substitutes for support.

- Product/runtime assembly uses `makeOwnedPersonalDeviceHost` with resource-owning
  port Layers. Its bounded close retains the actual drain and all dependencies;
  the lower-level scoped constructor still joins actual native work. Keep the
  complete incomplete-close failure and its recovery owner until confirmed close,
  and refuse same-binding handoff meanwhile. Borrowed ports must outlive that owner.
- Concurrent close callers share one ticket; serialize finite ticket creation,
  never native settlement. Worker-to-consumer plaintext transfer owns cleanup
  before and after publication, including cancellation of the waiting consumer.

- Shared runtime assembly uses the existing platform DTOs and one content bridge.
  Opening a reader never starts pairing. Bind reader retirement to its captured
  account and owner; retain incomplete failures until actual close confirmation.
  Account change retires the assembly permanently. Only real optional port Layers
  advertise RPC or machine sharing; no unsupported channel becomes plaintext.

- `personalRuntimeRecovery` exposes only closed setup/restore commands on the
  existing owned host. Setup requires an active reader; callers release only
  their own reader. Recovery failure never retires unrelated content readers.

- Member approval on the portable runtime uses the optional `members` platform port with
  the session's own credential. A listed key package is pinned per session; approval
  signs only that pinned package through the session's ledger journal, never re-signs on
  a lost reply, and key delivery afterwards never holds or undoes the admission.
- Joining a team on the portable runtime prepares this workspace's identity for
  `memberPairingOffer`, whose request id is the admitted membership and the pairing
  session of the credential binding. The key package is retained before submission and
  resubmitted unchanged on retry. The relay's `committed` is a hint: only this device's
  admission in the verified full signed history is accepted, as a history approval.
- A new invitation after an ended join first retires the old request through the relay;
  only `cancelled` writes the terminal receipt that settles it. The old credential is
  pinned to that membership, so the new one gets a replacement identity, activated only
  after its own verified admission. An admitted or still-live join keeps refusing.
- Automatic pairing approval signs only after the person types the code the new
  device shows and it equals this device's derived code. Reviews never expose that
  code, and the third wrong entry ends the request on the approver before any signing.
