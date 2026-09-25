# Quick Tunnel preview

Status: draft
Translation: current

[中文](quick-tunnel-preview.zh.md)

A user can start a development server themselves and submit `localhost:5173`
in the Session Browser. The address always names the Session's machine. Enter
authorizes that exact loopback origin; it does not start the development server
and does not open another confirmation dialog. Agent suggestions, typing, and
mounting a panel cannot authorize public exposure.

## Ownership and access

The CLI owns the target-bound HTTP/WebSocket proxy, endpoint credentials, and
cloudflared child. Local viewing uses a separate loopback endpoint without a
cloud dependency. Remote viewing uses an ephemeral Quick Tunnel directly; no
Worker gateway, custom transport protocol, legacy link mapping, or fallback.
The two endpoints share forwarding code, never credentials or listeners.

Share creates or reuses the Session's one remote endpoint and copies its
capability-bearing URL. Anyone with that link may view and interact without
logging into Lody. Every HTTP request and WebSocket upgrade must authenticate;
matching Origin or a tokenless Referer is not authorization. A link holder cannot
create, restore, or retarget a tunnel. Only an authenticated authorized Session
user can perform those control operations.

Remote control requires the machine's `previewControl` protocol capability v1.
A dedicated `machine/preview-control` handshake supplies the runtime nonce used
by signed control proofs; it does not grant access or create an endpoint.
Keep the general `machine/status` response unchanged for older clients. Machines
without the capability require an upgrade, not a legacy Preview fallback.

Only exact localhost or literal loopback targets are allowed. Requests remain
bound to the approved origin. Probe and forwarding use the same literal loopback
address, preserving the approved Host and TLS identity; ambient DNS or HTTP proxy
settings cannot redirect local target traffic. Credentials must not reach the development server,
annotation data, logs, or navigation history. Revocation invalidates credentials
and closes in-flight requests and sockets before releasing owned resources.

HTTP/WS forwarding maps an Origin equal to the exact bound viewer origin back
to the approved local origin, consistently with Host/Referer translation.
Foreign, opaque and missing origins remain unchanged so application cross-site
checks still apply. This mapping grants no access without endpoint credentials
and does not require weakening a development server's origin allowlist.

## Lifecycle and Browser

A lightweight lifecycle child owns each native connector and its temporary
configuration. Normal shutdown and loss of the CLI's private IPC connection
release those resources, including when the CLI is forcibly killed. This child
has no polling or restart policy and never owns the development server. Shutdown
completion waits for actual process exit; cleanup failure is an error. This does
not promise recovery when the lifecycle child itself is forcibly killed.

Remote state is `creating`, `active`, `closed` (with reason), or `failed`.
Active requires a successful public HTTP round trip, independently of optional
annotation. Failures retain their cause; there is no automatic replacement or
silent transport fallback. One Session serializes creation and closure.
Foreground Browser status refreshes check public reachability with a bounded
probe, not child-process liveness. A failed check exposes failure and restore;
forwarded application 4xx/5xx responses are not tunnel faults. Checks cannot renew
idle time or overwrite a newer endpoint.

Remote idle timeout is one hour. Authorized HTTP requests, application WebSocket
data, and a foreground remote Browser's low-frequency control heartbeat renew it.
Probes, status reads, invalid requests, protocol ping/pong, hidden Browser panels,
and local viewing do not. Expiration cannot be reversed by a late request.
Activity stays in CLI memory, not high-frequency shared document writes.

Browser exposes connection state as one address-bar status control with a
distinct icon and accessible name; opening it shows the short textual state,
the local/remote relationship, relevant diagnostics, and applicable recovery or
stop-sharing actions. It preserves the facts that Enter authorizes the exact
localhost target, link holders can access the shared preview, and remote sharing
stops after one hour idle. Expired/failed remote content is replaced with a
reason and one-click restore action, preserving the development address, path,
and query. Restore is new explicit authorization and loads a new endpoint
without replaying application operations. Browser explains that the share link
changed and offers copying it. Offline/ended Sessions show why restoration is
unavailable. Closing remote sharing never stops local viewing or the user's
development server. Panel unmount does not close the endpoint.

## Boundaries and verification

Quick Tunnels have temporary addresses, no SLA, a 200-in-flight-request limit,
and no SSE support. Errors are explicit. Fixed-version, integrity-checked
cloudflared is product-managed, never an unknown PATH binary or system service.
No iOS simulator work or new application Cookie/OAuth guarantees are included.

Implementation is in progress. Acceptance requires behavioral HTTP/WS tests,
deterministic idle/cancellation tests, actual iframe authentication on supported
clients, Browser recovery tests, binary lifecycle checks, and separate real-network
performance measurements. Passing proxy tests alone does not establish completion.

Evidence: [CLI preview](../apps/cli/src/preview/AGENTS.md),
[annotation contract](preview-annotation-availability.md).
