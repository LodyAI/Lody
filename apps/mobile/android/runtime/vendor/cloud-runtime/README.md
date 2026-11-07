# Shared Cloud runtime

Browser-only Lody Cloud protocol used by the iOS and macOS offscreen WebViews.
There is no root export: mobile imports verified pure helpers and types through
explicit public subpaths; native asset builders bundle `src/runtime/index.ts`.
This package imports no application, React Native, Expo or platform bridge code.

`src/models` owns wire shapes; `src/protocol` owns pure projections and capability
rules. Catalog projection accepts fallback labels. The mobile facade supplies its
current locale; the isolated runtime retains its existing English defaults.
Mobile attachment drafts and the durable send scheduler remain mobile-owned.

`scripts/build.mjs` exports `buildDataRuntime(output)`. It builds a local-only
HTML document with the existing CSP and inline WASM and copies dependency license
text alongside it. Platform builders supply their own output directory.

Run `pnpm --filter @lody/cloud-runtime typecheck`. Existing behavioral fixtures
under `apps/ios/tests` now load these shared production sources, retaining
protocol, write ordering, uncertain delivery and recovery checks.

## Host contract

The host (iOS today, a future Android host) talks to the runtime only through
versioned JSON envelopes: `{v, gen, kind, id?, method, payload | error}` with
`kind` one of `request`, `result`, `error`, `event`. Every host↔runtime method
is on the contract; there is no other bridge. The runtime's only global is
`dataRuntime.receive(envelope)`, and it posts `ready` once followed by
`envelope` messages.

`src/contract` is the single source: schemas live in per-domain files
(`core.ts`, `sessions.ts`, …), each named with `.meta({ id })`, and `methods.ts`
only lists host→runtime calls (`runtimeCalls`), runtime→host calls
(`hostCalls`) and runtime events. `src/runtime/channel.ts` validates every
inbound payload and outbound result, enforces call timeouts, and adopts the
host generation from the `hello` handshake. `src/runtime/index.ts` owns the
bootstrap and catalog replicas; `src/runtime/handlers/*.ts` register the
`channel.handle` implementations by domain and receive the shared state as a
`RuntimeContext` argument.

`pnpm contract` writes `contract/runtime-contract.json` (JSON Schema) and the
generated Swift types in `packages/lody-core/Sources/LodyCore/Contract`;
`pnpm contract:check` fails when either is stale. Unions need a string `const`
discriminator; `z.unknown()` becomes `RuntimeContract.JSONValue`.

To add a method: define its schemas in a domain file and its table entry,
register the runtime side in the matching handler module (`channel.handle`) or
call the host with `channel.request` / `channel.emit`, handle it in the host
through `RuntimeChannel` (iOS: `DataRuntime+*.swift`, using `callForRN` when
the result goes to RN), run `pnpm contract`, and add its envelopes to
`contract/fixtures/to-runtime.json` / `to-host.json`. Both
`apps/ios/tests/cloud/contract.test.mjs` and
`swift test --package-path packages/lody-core` check the same fixtures.
