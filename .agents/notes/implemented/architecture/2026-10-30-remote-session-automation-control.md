# Remote Session automation control

Date: 2026-10-30
Status: implemented
Translation: current

[中文](2026-10-30-remote-session-automation-control.zh.md)

## Abstract

Electron's Session controls manage the automations of a Session on another machine through scoped operations on the existing Machine RPC, while the remote workspace Host and ledger stay authoritative. Workspace RPC cannot authenticate a claimed user, so each request carries an operation-bound cloud proof modeled on remote Preview. The machine owner and any collaborator who can currently edit the Session may list, configure and cancel; each command, read and delivery acts as one verified principal whose edit access is rechecked when it takes effect. Encrypted workspaces have no remote control because their RPC is withheld.

## Design boundary

For supported plaintext workspaces, the Session UI addresses the Session's actual machine through the workspace Machine RPC facade. That transport routes local requests to the existing local owner and remote requests over the existing Streams RPC. The target daemon invokes its existing automation workspace owner for the exact workspace and Session; the owner keeps its ledger, scheduling, cancellation and admission responsibilities. The surface has only list, settings, configure and cancel, with bounded public results. It does not forward arbitrary Agent programs or copy the ledger into Workspace metadata.

The target advertises a versioned automation-control capability. Older machines are shown as unsupported; offline, timed-out and unknown outcomes stay distinguishable from an empty list or confirmed success. Mutations use the same Session identity throughout; cancellation is restricted to a Wait in that Session. A timed-out write is not assumed to have failed or blindly replayed: refresh the owner state to resolve what is observable. Existing Session policy configuration and cancellation semantics determine what can be reconciled.

Remote Wait lists use byte-sized pages ordered by the ledger; the client signs each cursor and joins pages before presenting them. The Automation response has its own bounded encrypted-envelope size so a valid long reason fits without widening limits for other RPC secret uses. The fast machine handshake uses the control lane; Session operations use ordinary bounded admission because proof verification can wait on cloud I/O. A slow verifier therefore cannot occupy the reserved Stop and Steer slots, though Automation requests can be refused under ordinary overload.

## Caller identity

Caller authority follows the [remote Preview proof](../../../../apps/cli/src/preview/preview-control-authority.ts) pattern. The signed intent binds the requester, workspace, machine, Session, exact operation and parameters, runtime nonce, request ID and response key. The cloud issuer takes the requester from the signed-in session, never from the request body, and the target daemon verifies the same intent with its CLI credential; the verifier also requires that the requester may use the machine. Automation has its own issuer, verifier, token version and secret domain, so a Preview proof cannot authorize an automation operation.

[Machine RPC rules](../../../../packages/loro-streams-rpc/AGENTS.md) state that workspace RPC cannot authenticate a claimed requester. `verifyMachineAccess` checks whether a named user can access a machine, not whether that user sent the request. The Code Collab envelope derives its content key from the Session ID and cannot prove caller identity. A `userId` supplied in an RPC payload is not proof: before verification the target checks only that the Session is live on this machine, and afterwards the verified requester must equal the claimed one.

## Who may act

The ledger is machine-local, but its rules, waits and pending work record their author. Every command, condition read and delivery acts as one principal: the verified remote requester, the author of the active Agent input for MCP commands, or the machine owner for the local CLI and Electron IPC. That principal must currently be able to edit the target Session: the machine owner, or a collaborator with machine sharing (and project sharing for a local project). `SessionAutomationAuthority.canEdit` reuses the same machine/project check as Session input, including the verified sharing policy in encrypted workspaces. A check that cannot be confirmed returns `unknown`, so work waits instead of running or failing.

Anyone who can edit a Session sees every author's waits and activity in it and can cancel them. Session policies are one rule per Session, so the last editor who configures one becomes its author, and recovery continuations run as that author with the machine's Agent configuration. Delivery rechecks the author's edit access; revoking it stops later continuations. Starting a new Session from a rule stays with the machine owner.

## Envelope and limits

The target consumes each proof once under its runtime nonce and rechecks edit access after verification. RPC uses the existing owner-Session envelope for the request and response. The owner joins in-flight verification when it closes; cancellation and execution remain with the existing Automation runtime.

The owner-Session envelope does not protect a bearer proof against a Workspace peer who knows the Session ID: its key derives from that ID. The intent binds an ephemeral response public key, and the target encrypts the result to that key; a peer cannot redirect a valid result to a substituted recipient. This does not authenticate the sender of a response: anyone with the public key can encrypt a forged response, and a peer can still race a visible proof for its single use. This remains a property of the shared Workspace RPC trust model.

A collaborator's edit access is checked with the backend each time their command, read or delivery takes effect, without a cache; the machine owner needs no network check. Tests use synthetic secrets, edit-access stubs and in-memory RPC transport; they do not establish deployed cloud authorization or a real cross-machine delivery. Encrypted workspaces run automations locally, but the shared content policy withholds their RPC; Fleet and the renderer gate remote control on that `rpc` verdict.
