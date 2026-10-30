# Remote Session automation control

Date: 2026-10-30
Status: proposed
Translation: current

[中文](2026-10-30-remote-session-automation-control.zh.md)

## Abstract

Agents can manage automations on their own machine, but Electron's Session controls reject remote machine IDs. The proposed path adds scoped automation operations to the existing Machine RPC and keeps the remote workspace Host and ledger authoritative. Workspace RPC cannot authenticate a claimed user identity; the existing remote Preview proof supplies a concrete authorization pattern, but its operation-specific cloud issuer and verifier must be extended for automation. Encrypted workspaces remain outside this proposal.

## Design boundary

For supported plaintext workspaces, the Session UI addresses the Session's actual machine through the workspace Machine RPC facade. That transport routes local requests to the existing local owner and remote requests over the existing Streams RPC. The target daemon invokes its existing automation workspace owner for the exact workspace and Session; the owner keeps its ledger, scheduling, cancellation and admission responsibilities. The surface needs only list, settings, configure and cancel, with bounded public results. It must not forward arbitrary Agent programs through this UI operation or copy the ledger into Workspace metadata.

The target advertises a versioned automation-control capability. Older machines are shown as unsupported; offline, timed-out and unknown outcomes stay distinguishable from an empty list or confirmed success. Mutations use the same Session identity throughout; cancellation is restricted to a Wait in that Session. A timed-out write is not assumed to have failed or blindly replayed: refresh the owner state to resolve what is observable. Existing Session policy configuration and cancellation semantics determine what can be reconciled.

Remote Wait lists use byte-sized pages ordered by the ledger; the client signs each cursor and joins pages before presenting them. The Automation response has its own bounded encrypted-envelope size so a valid long reason fits without widening limits for other RPC secret uses.

Caller authority must follow the existing [remote Preview proof](../../../../apps/cli/src/preview/preview-control-authority.ts) pattern. The signed intent binds the authenticated requester, workspace, machine, Session, exact operation and parameters, runtime nonce, request ID and expiry; the cloud issuer authorizes the signed-in user and the target daemon verifies the same intent with its CLI credential before using its owner. Preview's existing proof only permits Preview/Simulator operations; Automation needs explicit cloud issuer/verifier support and a separate public port contract, not a forged Preview action. The current ledger, command owner and action authorization use the daemon's `auth.userId`; initially restrict this feature to a verified requester who is both the Session and daemon owner. Shared-machine collaborator support requires changing those owner checks and rechecking the actual user's authorization at delivery, not only at the RPC boundary.

[Machine RPC rules](../../../../packages/loro-streams-rpc/AGENTS.md) state that workspace RPC cannot authenticate a claimed requester. `verifyMachineAccess` checks whether a named user can access a machine, not whether that user sent the request. The existing Code Collab envelope derives its content key from the Session ID and cannot prove caller identity. A `userId` supplied in an RPC payload is not proof.

The public [remote intent and proof schemas](../../../../packages/shared/src/automations/control.ts) define the exact proposed scope and exclude program registration. The workspace owner, Machine RPC and renderer route are connected to injected verification and issuance ports, with cloud composition installing the issuer and verifier and advertising the capability on cloud machines. The UI also requires an installed issuer. The target consumes each proof once under its runtime nonce and rechecks Session ownership after verification. RPC uses the existing owner-Session envelope for the request and response. Its Session identity is checked directly, without requiring a worktree or Roost history. The owner joins in-flight verification when it closes; cancellation and execution remain with the existing Automation runtime.

The owner-Session envelope does not protect a bearer proof against a Workspace peer who knows the Session ID: its key derives from that ID. The intent now binds an ephemeral response public key, and the target encrypts the result to that key; a peer cannot redirect a valid result to a substituted recipient. This does not authenticate the sender of a response: anyone with the public key can encrypt a forged response, and a peer can still replay a visible proof. This remains a property of the shared Workspace RPC trust model; one-time consumption and a nonce do not authenticate replies or conceal a proof. Synthetic tests verify recipient confidentiality and binding, not peer authentication.

The cloud issuer and verifier require a matching backend deployment. The public client and daemon ports are connected, but this branch and its backend changes have not been deployed together. Tests exercise signing with synthetic secrets, workspace owners, renderer ports and in-memory RPC transport; they do not establish deployed cloud authorization or remote delivery. Existing encrypted workspace policy continues to withhold both RPC and automation. The accessible machine catalog currently exposes only one online machine, so a real cross-machine test was not performed.
