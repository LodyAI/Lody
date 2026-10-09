# Simulator handshake for opaque desktop origins

Status: implemented
Translation: current

[中文](2026-10-02-simulator-desktop-handshake.zh.md)

## Abstract

Packaged Electron loads its renderer from `file://`. It reports `window.origin` as
`file://`, but the receiving iframe sees the message origin as `null`. The simulator artifact rejected that parent's init,
so a ready local operation could show a black screen and eventually `viewer=error`
while web/mobile viewers worked. Desktop parents now transfer a dedicated MessagePort
to the exact viewer origin; the artifact binds it to the parent and operation.
Web parents keep the existing exact-origin protocol. Both renderer and CLI must update.

## Boundary and lifecycle

```text
file parent -- init + transferred port, exact iframe targetOrigin --> viewer
file parent <---------- bound port: state / controls / PNG ----------> viewer
web parent  <---------- existing exact-origin window messages -------> viewer
```

A null origin alone is not authority. The first init must come from the exact parent,
name the operation, contain a boolean visibility and transfer exactly one port. Once
bound, opaque window commands and replacement ports are ignored. Operation/request
validation remains shared with web clients. No screenshot or other response uses `*`.

The renderer closes and fences old ports on iframe load, URL/operation replacement
and unmount, and settles pending commands before rebinding. The same protocol works
for loopback and tunnel viewer URLs. Accepting null origins with wildcard replies was
rejected because it cannot address the original parent document safely.

This corrects the handshake assumption in the
[simulator architecture note](../architecture/2026-09-27-ios-simulator-panel.md),
without changing the private capability or device lease model.

## Verification

The actual inline viewer artifact is exercised with a null-origin parent: it cannot
start without a valid transferred port, then paints frames and returns controls and
captures through that port. Spoofed window commands, wrong operations and replacement
ports are rejected. The React panel suite covers bound state/control replies, reload
cancellation, stale messages, visibility and unmount cleanup; web tests remain intact.
Packaged Electron end-to-end preview remains a field verification requirement.

A real Chrome file-page smoke using the actual viewer artifact reached ready,
returned a control acknowledgement and captured a PNG over the transferred port.
The parent reported `window.origin=null`. Synthetic JPEGs and controls isolated the
handshake from the simulator; this does not replace packaged Electron field testing.

Validation completed: standalone public `pnpm check` (CLI 3,454 passed, four skipped;
components 4,722 passed), quick checks, formatting and docs checks passed. CLI built
with the required 2 GiB heap; Electron renderer built with its normal configured heap.
Security, correctness, scope/simplification and fresh adversarial reviews found no
P0/P1. Outer affected checking stops on the intentionally different OSS pin in this
public-only checkout; no private gitlink or revision manifest is changed.

## Correction: Electron self-origin differs from message origin

The first patch selected a port only when `window.origin === 'null'`. That passed
Chrome file-page validation but still failed in packaged Electron: Electron 43.7.6
reports its own origin as `file://` while serializing the outgoing message as `null`.
The renderer now also selects the port when `location.protocol === 'file:'`.
The receiver's admission rules and all non-file web behavior are unchanged.

The owning React regression now uses an actual file URL and Electron's self-origin;
restoring the old condition makes it fail. An isolated Electron window with the same
sandbox/context-isolation settings connected to the live native preview, reached
ready and returned a PNG through the bound port. The installed product still needs
its renderer rebuilt/restarted; a CLI already containing the first patch needs no
further update. Chrome alone cannot validate Electron's file-origin semantics.
