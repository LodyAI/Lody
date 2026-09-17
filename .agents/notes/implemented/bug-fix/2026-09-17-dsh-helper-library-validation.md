# Let macOS helpers load runtime-installed native addons

Status: implemented
Translation: current

[中文](2026-09-17-dsh-helper-library-validation.zh.md)

## Abstract

Signed macOS builds could not start the DeepSeek Harness at all: its local plugin tree
needs koffi's native binding, which npx installs with only an ad-hoc signature, and
macOS library validation refuses to map such a library into the Team-ID-signed, hardened
Lody Helper that now runs DSH. The host observed only `ACP connection closed`. Nested
macOS binaries are now signed with a separate `entitlements.mac.inherit.plist` carrying
`com.apple.security.cs.disable-library-validation`, while the top-level app keeps library
validation enabled. The exception is broader than DSH by necessity — any agent-installed
addon needs it — and it weakens dylib provenance for helper processes, including the
renderer, because electron-builder has no per-helper entitlement granularity.

## Cause and decision

[Running DSH with Lody's bundled Node](2026-09-16-dsh-bundled-node-runtime.md) made the
host launch DSH under `process.execPath`, which in the packaged desktop is Lody Helper.
That decision fixed a silent exit on user Node installations, but it moved DSH into a
process signed with the product Team ID and `hardenedRuntime: true`. DSH's local plugins
(`dsh-subprocess-local`, `dsh-sandbox-local`, and also `dsh-fs-local` and
`dsh-session-persistence-jsonl`) load `@koromix/koffi-darwin-arm64`, which npx
materializes in Lody's npm cache with a linker/ad-hoc signature and no Team ID. Library
validation rejected the mapping:

```
dlopen(.../@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node, 0x0001):
  code signature ... not valid for use in process:
  mapping process and mapped file (non-platform) have different Team IDs
```

One failed loader entry fails the whole plugin tree, DSH exits, and the host surfaces
`ACP connection closed` with no actionable cause. Under the previous launch the same
binding loaded, and not because the user's Node was unhardened: an upstream Node 22.23.1
is signed with the hardened runtime under Team `HX7739G8FX` and carries
`com.apple.security.cs.disable-library-validation` itself. Every general-purpose Node
runtime must, because loading third-party addons is its job. Adopting DSH's runtime meant
adopting that requirement without the entitlement that satisfies it.

The exception belongs on nested binaries only, so it is a second build resource rather
than a new key in `entitlements.mac.plist`. `app-builder-lib` applies
`entitlementsInherit` to every signed path that is not the app bundle itself, which is
exactly the set that runs the embedded CLI and its agents; the browser process keeps
validation because it loads only bundle-signed libraries. Granularity stops there:
`entitlementsInherit` covers renderer and GPU helpers as well, which is the real cost of
this fix.

Two alternatives were weighed. Reverting to npx's Node would sidestep library validation
entirely, and the original `import.meta.main` breakage would not return because the
bootstrap already imports the entry and awaits `runCli()` explicitly; it was rejected
because it reintroduces exactly the variance across user Node installations that the
earlier decision removed. Shipping a Lody-signed `node` binary was rejected because a
Team-ID-signed hardened runtime hits the same wall without the same entitlement, so it
adds a download and a signing surface without removing the constraint.

## Verification

The failure and the fix were confirmed on the installed signed build (0.95.0, Team
`YTRMX32C99`, hardened runtime) with three controls sharing one npx closure
(`@deepseek-ai/dsh` 0.1.5-rc.2) and one generated profile:

| Runtime | Result |
| --- | --- |
| System Node 22.23.1 | valid ACP `initialize` (`acp-extension-dsh` 0.2.0) |
| Shipped Lody Helper | koffi `dlopen` rejected, plugin tree fails, process exits |
| Same Helper re-signed with this note's inherit plist | valid `initialize`, empty stderr |

The third control copied the app bundle, re-signed only the nested helper with the
committed `entitlements.mac.inherit.plist`, and left the installed app untouched. The
first control is not an unhardened baseline: that Node is hardened and Team-ID-signed and
already ships `disable-library-validation`, so the three rows isolate the entitlement as
the only variable that decides whether the load succeeds.

Limits: no full packaged, signed and notarized release was produced here, so
notarization acceptance of the entitlement is expected from Apple's documented exception
list rather than observed on a Lody artifact, and no automated check guards the plist.
Only load-time behavior was exercised; a live agent turn was not run. Windows and Linux
have no equivalent library validation and are unaffected.

## Integration

- [Lody PR #776](https://github.com/LodyAI/Lody/pull/776)
- Follows [running DSH with Lody's bundled Node](2026-09-16-dsh-bundled-node-runtime.md)
