# apps/cli/src/preview

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Managed preview tunnels and the local proxy. [apps/cli/AGENTS.md](../../AGENTS.md) applies.

- Preview targets are untrusted, and a managed preview reaches THIS machine's loopback and
  nothing else — agent candidate or user-approved alike, there is no policy under which a LAN
  host is accepted (`normalizeTarget` in `preview-service.ts`). The tunnel makes this machine the
  origin of whatever it connects to, so a LAN target would turn it into a pivot into its own
  network for a remote workspace member or an agent that talked them into a click; the approver
  cannot see what a LAN address here even is. Clients never send one, but this check must hold for
  any client.
- Loopback means a literal address or the exact name `localhost`. `classifyBrowserHostname` reads
  the hostname text, so any `*.localhost` name passes it while a search domain or rebinding record
  can point that name at a LAN host.
- Still require a fresh approval from the session initiator, and validate path-relative targets
  here.
- The local preview proxy must never forward an OBSERVED WebSocket close code into a Close frame.
  RFC 6455 reserves 1005/1006 for local observation, so `ws` throws from a TCP callback and kills
  the CLI with the active Agent session. Mirror the shape instead (`mirrorWebSocketClose` in
  `local-preview-proxy.ts`): `terminate()` for 1006, code-less `close()` for 1005. Both
  directions, plus the local-socket `error` handler, which must not pre-empt that mirror once the
  connection is open.
