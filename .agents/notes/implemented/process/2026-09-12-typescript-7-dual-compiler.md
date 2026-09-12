# TypeScript 7 dual-compiler migration

Status: implemented
Translation: pending
PR: [#642](https://github.com/LodyAI/Lody/pull/642)

## Abstract

The repository used an old TypeScript 7 native preview for typechecks while its
tooling depended on the TypeScript 5 compiler API. TypeScript 7.0.2 is now stable,
but it intentionally does not expose the legacy API required by ESLint, declaration
generation, Storybook docgen, and repository documentation scripts. The workspace
therefore runs stable TypeScript 7 for command-line typechecks and supplies the
official TypeScript 6 compatibility package under the `typescript` name for API
consumers. This preserves tooling compatibility while making the compiler used at
the main validation boundary an actual stable major release.

## Pressure

The root installed `@typescript/native-preview` at a December 2025 nightly and
workspace scripts invoked its temporary `tsgo` command. Stable TypeScript 7 uses
the normal `typescript` package and `tsc` command, so the preview package no longer
represented the supported release channel. Replacing the existing `typescript`
dependency directly would break consumers of `createSourceFile` and other legacy
compiler APIs because TypeScript 7.0 ships no compatible programmatic API.

## Decision

Follow TypeScript's
[documented side-by-side installation model](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60):

- `@typescript/native` aliases `typescript@7.0.2` and owns the `tsc` executable.
- `typescript` aliases `@typescript/typescript6@6.0.2`, which exposes the legacy
  JavaScript API and a non-conflicting `tsc6` executable.
- Public workspace typecheck scripts invoke `tsc`; the isolated Kimi submodule is
  outside the root dependency graph and remains unchanged.

The catalog points every direct `typescript` dependency at the compatibility
package. This keeps peer-dependent tools on the API they declare support for while
avoiding a separate override for each tool. New code must not import TypeScript 7's
unstable API merely to remove the compatibility package; that can be reconsidered
after a stable API exists and the ecosystem consumers have migrated.

Four packages still cap their declared TypeScript peer at 5.x even though the
TypeScript 6 release retains the 5.9 API. Their pnpm allowances are scoped by package
name instead of globally accepting TypeScript 6 for every dependency.

## Verification

The two compiler boundaries were checked independently. `tsc --version` resolves
to 7.0.2; the compatibility package's `tsc6` reports its bundled 6.0.3 compiler;
and `import("typescript")` reports 6.0.3 with `createSourceFile` available. The
root typecheck passes across all 18 selected public workspaces, and the type-aware
Oxlint run completes with no errors. The complete `pnpm check` suite also passes,
including workspace tests, i18n validation, and public repository boundary guards.

The documentation script suite passes 27 tests, including TypeScript declaration
anchor parsing, and the repository document check passes. The components Storybook
build loads TypeScript-backed docgen and completes 10,396 module transforms when
given the existing required preview domain and an 8 GiB Node heap. Its default
4 GiB heap reaches the chunk-render stage and then exhausts memory; this is an
existing bundle-size constraint rather than a compiler compatibility failure.
