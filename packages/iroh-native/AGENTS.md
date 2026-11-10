# Native iroh transport

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

These rules bind the CLI machine listener (`apps/cli/src/lib/e2ee/iroh-listener.ts`)
and the desktop client (`apps/electron/src/main/services/e2ee-iroh.mts`) as well as
this package. Intent: [foundations Spec](../../specs/e2ee-foundations.md#preferred-route-iroh);
rationale: [iroh transport decision](../../.agents/notes/proposed/architecture/2026-11-10-e2ee-iroh-transport.md).

- This package moves opaque `{id, frame}` envelopes only. It never parses, verifies
  or authorizes a frame, and it exposes no signing, key export or frame inspection.
  Transport identity of a peer is never authority; receivers keep ledger checks.
- The endpoint secret is the workspace ledger device seed, handed over only through
  node custody's `withTransportSeed`. The binding zeroes the caller's buffer before
  returning and wipes its own copy when the endpoint drops. Never route the seed
  through IPC, a renderer, a WebView or a log.
- A process holds at most one live endpoint per device key; the core registry
  enforces it because two endpoints with one key make relays evict each other.
- Relays come only from the official build composition and every dial names all of
  them. Do not add DNS, Pkarr or control-plane address lookup. n0's public relays are
  the interim configuration until Lody relays exist; never hard-code either set here.
- Absence of the module, relays or a live connection means "use Streams RPC". Never
  let opening, dialing or a failed call delay an available later route, and retry
  only with the same original envelope.
- Keep the iroh floor at 1.4.1 or later and follow upstream security advisories.
  Mobile bindings must disable port mapping and `fast-apple-datapath`.
- Rust tests (`cargo test -p lody-iroh`) cover the wire and endpoint rules; Node
  tests load the development build and skip when it is absent.
