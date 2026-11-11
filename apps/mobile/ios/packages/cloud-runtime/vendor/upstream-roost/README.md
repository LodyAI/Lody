# Upstream Roost reader snapshot

Source is from public Lody commit
[`57750dd60f972c6c76510d0191cfc8cfb74afe52`](https://github.com/LodyAI/Lody/commit/57750dd60f972c6c76510d0191cfc8cfb74afe52).
Every file under `packages/components/` and `packages/shared/` is copied verbatim
from the same repository-relative path at that commit.
`packages/acp-extension-dsh/src/capabilities.ts` is from its upstream submodule
commit `b1b0735fd8c38d191c87d6fbd14f7a27c0f0421e`, with its
[license](../../licenses/acp-extension-dsh-LICENSE.txt) in the runtime package.
The public `acp-extension-core` dependency is pinned to 0.3.0, whose source
matches the Lody submodule commit `ea90d0b23d4f850c66c0f542f53cbc596ef2c62f`.

The pin includes the shared workspace input extraction reviewed separately in
[#2536](https://github.com/LodyAI/Lody/pull/2536), which must merge before the
native integration. These files now have the same public source commit as the
rest of the snapshot:

- `packages/components/src/lib/workspace-accepted-inputs.ts`
- `packages/components/src/lib/session-send-delivery.ts`
- `packages/components/src/lib/session-send-resources.ts`

To refresh, export each file's repository-relative path from the chosen public
source commit, and update the source pin and Android provenance together. Keep
the three browser export selectors (`entry.ts`, `shared-entry.ts`, `session-data.ts`)
local; they select public APIs without implementing Roost behavior.

Run `node scripts/build-upstream-roost.mjs` to regenerate the runtime module.
The iOS asset build verifies the module. Android's runtime snapshot carries
the verified browser module and its license files.
