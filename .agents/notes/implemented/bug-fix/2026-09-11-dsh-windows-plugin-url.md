# Import the DSH adapter through a file URL

Status: implemented
Translation: pending

## Abstract

The built-in DeepSeek Harness launch passed a Windows drive path to the Cordis
ACP plugin entry, causing Node's ESM loader to reject the `c:` scheme before ACP
initialization. Lody now converts its bundled adapter path with `pathToFileURL`
before generating the composition. Preset and session directories remain native
filesystem paths. The change also preserves literal spaces, Unicode, percent
signs, and URL fragment characters in installation paths.

## Decision and ownership

The host owns the bundled adapter's filesystem location; the extension profile
serializes its supplied entry directly into the Cordis module name. Convert at
that boundary instead of patching the downloaded official loader or manually
prefixing `file://`, which would miss escaping and Windows/UNC semantics. The
existing content hash gives the corrected configuration a new filename without
changing runtime package pins or touching user settings and session artifacts.

This fixes launch compatibility without changing product intent. The existing
[settings integration note](2026-09-08-dsh-settings-provider.md) explains why
generated configuration is host-owned and manual edits are not durable.

## Verification

The owning runtime suite adds a synthetic adapter under a directory containing
spaces, Unicode, `#`, and `%`. It reads the generated module specifier and loads
that exact value through a separate Node process, checks the preset directory
remains a filesystem path, and checks repeat launch configuration is stable.
The fixture uses the host's native paths so the same test exercises drive paths
on Windows. Native Windows desktop startup remains to be verified.

All seven runtime tests passed on macOS with isolated Vitest 3.2.4 and the pinned
extension profile source; removing the URL conversion makes the new regression
test fail. Isolated strict TypeScript checking of the runtime and its test,
scoped TypeScript formatting, and `git diff --check` passed. Root
`pnpm check` and `pnpm format` were attempted but cannot complete in this checkout
because workspace dependencies and other adapter submodules are missing.
`pnpm run docs check` reports existing links into uninitialized Core/Codex
submodules; it reports no errors for this note.

## Integration

- [Lody PR #599](https://github.com/LodyAI/Lody/pull/599)
