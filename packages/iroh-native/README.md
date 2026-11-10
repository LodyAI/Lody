# @lody/iroh-native

Encrypted-workspace RPC over [iroh](https://iroh.computer): the preferred route ahead
of encrypted Streams RPC and durable dispatch. Rules: [AGENTS.md](AGENTS.md).

## Layout

- `core/`: the `lody-iroh` crate. Endpoint lifecycle, ALPN `lody/e2ee-rpc/1`
  framing (one bidirectional stream per request, big-endian `u32` length-prefixed
  messages up to 2 MiB + 4 KiB) and the one-endpoint-per-key registry.
- `napi/`: the Node-API binding used by the Electron main process and the CLI.
- `index.js` / `index.d.ts`: an explicit-path loader. `loadIrohNative(file)` returns
  `undefined` when the file is unset, missing or unloadable.

## Build

```sh
pnpm --filter @lody/iroh-native build        # release build for this host
pnpm --filter @lody/iroh-native build:debug  # faster local build
pnpm --filter @lody/iroh-native test:rust    # cargo tests, including a local relay
pnpm --filter @lody/iroh-native test         # Node binding tests (needs a build)
```

The output is `lody-iroh.<platform>-<arch>.node` beside `index.js`. Set
`LODY_IROH_TARGET`, `LODY_IROH_PLATFORM` and `LODY_IROH_ARCH` to cross-build.

## Shipping

The public desktop and the standalone npm CLI ship no module and keep Streams RPC.
The official cloud desktop build ships the module for its target in the app's
resources directory (signed with the app on macOS) and sets `VITE_IROH_RELAYS` and
`VITE_IROH_RELAY_TOKEN`. Main loads it from there and passes `LODY_IROH_RELAYS`,
`LODY_IROH_RELAY_TOKEN` and `LODY_IROH_NATIVE_PATH` to the embedded CLI.

## Not yet verified

Send-to-actual-start latency per route, hole-punching rate, Windows firewall prompts
on the listening machine and module loading in every packaged installer.
