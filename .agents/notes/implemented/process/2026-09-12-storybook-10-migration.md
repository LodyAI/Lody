# Storybook 10 migration

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/631

## Abstract

The component library and standalone review renderer now use a single Storybook
10.6 toolchain. The component Storybook configuration is ESM, as required by
Storybook 10, while its existing Tailwind, WebAssembly, ES worker, and top-level
await behavior remains explicit. Storybook stays on the existing Vite version in
this change so the framework migration can be validated independently from the
later Vite 8 stack layer.

## Pressure

Storybook 9's Vite integration did not accept Vite 8. Upgrading Storybook at the
same time as Vite would combine framework configuration changes with the Rolldown
bundler migration. The component configuration also remained CommonJS, which is
no longer supported by Storybook 10.

## Decision

Both workspaces align `storybook`, `@storybook/react`, and
`@storybook/react-vite` on 10.6. The component configuration becomes
`.storybook/main.ts`, uses `import.meta.url` to resolve the package root, and
retains the same plugin filtering and worker pipeline. No Storybook test addon is
introduced, so this migration does not create a dependency on the Vitest upgrade.
