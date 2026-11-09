# Upstream Roost reader snapshot

Base source is from Lody commit `8c27d5a2a5fdfb722ef84bf719dd889f5e5c79c7`.
`packages/acp-extension-dsh/src/capabilities.ts` is from its upstream submodule
commit `b1b0735fd8c38d191c87d6fbd14f7a27c0f0421e`, with its
[license](../../licenses/acp-extension-dsh-LICENSE.txt) in the runtime package.
The public `acp-extension-core` dependency is pinned to 0.3.0, whose source
matches the Lody submodule commit `ea90d0b23d4f850c66c0f542f53cbc596ef2c62f`.

The browser entry selects the remote history bridge, input schemas, and workspace
input coordinator. The following files include the shared workspace input
refactor and durable input writes. They are copied verbatim from Lody:

- `packages/components/src/lib/workspace-accepted-inputs.ts`
- `packages/components/src/lib/session-input-storage.ts`
- `packages/components/src/lib/session-send-delivery.ts`
- `packages/components/src/lib/session-send-resources.ts`

Run `node scripts/build-upstream-roost.mjs` to regenerate the runtime module.
The iOS asset build verifies the module. Android's runtime snapshot carries
the verified browser module and its license files.
