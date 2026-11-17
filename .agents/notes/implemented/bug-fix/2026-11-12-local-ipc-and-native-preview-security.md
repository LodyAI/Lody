# Local IPC and native HTML preview boundaries

Status: implemented
Translation: current

[中文](2026-11-12-local-ipc-and-native-preview-security.zh.md)

## Abstract

Predictable Windows control and data-plane pipe names are insufficient authorization. The daemon publishes random pipe addresses and a separate per-process secret through its private run file; control, probe and data-plane servers require that secret before dispatch. Native iOS HTML previews retain HTTPS static resources while blocking active connections, forms, nested documents and navigation. These controls reduce specific exfiltration channels, but allowing arbitrary HTTPS static resources cannot guarantee complete data isolation.

## Decisions

`daemon.json` atomically carries the token and endpoint addresses with mode `0600`, inside the private run directory. Windows pipe suffixes and tokens each contain independent 256-bit randomness. HTTP requests carry `x-lody-local-token`; the data plane requires an `authenticate` frame followed by an `authenticated` receipt before Electron publishes connected status or forwards renderer traffic. Malformed, missing and mismatched secrets are refused using a constant-time comparison for valid-length tokens. Unauthenticated sockets have a bounded first-frame size and deadline.

Clients discover endpoints and credentials together. HTTP caches invalidate on connection failures or explicit local authentication rejection. A previously cached endpoint retries once only after a pre-connect `ENOENT`/`ECONNREFUSED` or the server's pre-dispatch `local_ipc_unauthorized` response, and only if the published address or token changed. Timeouts, disconnects after connection and business authorization failures never replay a request. Electron redials reread the run file. Builtin stdio and HTTP MCP discover control lazily; stdio forwards the platform/data-directory selectors, while an explicit socket override tolerates unavailable default metadata without borrowing its token. Old clients without the secret cannot use the hardened servers; both installed components need updating. Named-pipe authorization does not make Windows filesystem mode bits into an ACL: deployment must retain the user's private profile-directory ACL. Privilege-level sharing, the Host lease and terminal protocols remain separate.

Native previews always prepend CSP before authored markup, so an existing permissive policy cannot weaken it and a stricter policy remains effective. The trusted `RuntimeDocument` data runtime keeps its required cloud connections. Preview navigation admits only its initial document and same-document anchors; links and popups cannot silently launch an external browser. Removing HTTPS scripts/images was rejected because it would break the selected CDN rendering behavior. Those permitted requests can still carry data in resource URLs, and third-party scripts still execute within the preview.

## Verification boundaries

The existing local IPC and data-plane suites exercise actual socket refusal and successful dispatch; relay tests exercise pending handshakes and replacement connections. `RuntimeContractTests` exercises the preview policy in WebKit, including static JavaScript/CSS and CSP violations for active connections and forms. These checks do not establish Windows ACL behavior, real CDN availability or native device acceptance.
