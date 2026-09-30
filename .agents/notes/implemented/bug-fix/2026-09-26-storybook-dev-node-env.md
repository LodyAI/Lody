# Storybook dev environment and React Refresh

Status: implemented
Translation: current

[中文版](2026-09-26-storybook-dev-node-env.zh.md)

## Abstract

The shell used for this workspace exports `NODE_ENV=production`, including when a
developer starts Storybook's dev server. Vite then marked the serve config as
production and skipped React Refresh's runtime wrapper, while its JSX transform
still emitted refresh signatures. The Storybook config now resets that inherited
value for `storybook dev` only, leaving static Storybook builds in production.

## Problem

Storybook's iframe failed while evaluating `packages/ui/src/theme/theme.tsx`
with `$RefreshSig$ is not defined`. The browser served a module containing the
signature call without its helper. The preview preamble was empty because the
React plugin had resolved the server as production, despite Vite serving modules
in development mode.

## Decision

When the Storybook CLI arguments include `dev`, `.storybook/main.ts` changes an
inherited production `NODE_ENV` to `development` before Vite loads the component
package config. This lets React Refresh install the runtime that matches the
serve transform. `storybook build` does not take this path and retains production
semantics.

This is a follow-up to the [Storybook 10 migration](../process/2026-09-12-storybook-10-migration.md),
which recorded the Vite integration but not the inherited environment behavior.

## Verification

With the shell still exporting `NODE_ENV=production`, the Storybook dev server
served `theme.tsx` with both `$RefreshSig$` usage and its function definition,
and the `Sessions/SessionInfoCard / Team scope (with Author row)` story rendered
in Chromium. Its screenshot was uploaded to the current Lody conversation.
