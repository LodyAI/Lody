# `@lody/components` contributor guidelines

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Root `AGENTS.md` also applies.

This package contains shared React UI for browser-shaped, Electron, and responsive
mobile surfaces. Background for the rules below:
[.agents/docs/components-package.md](../../.agents/docs/components-package.md).

## General rules

- Regenerate TanStack routes after changing route files.
- Add Storybook coverage for new presentational components and meaningful states.
- All user-visible copy must go through i18n.
- Compact number units (K/M/B vs 万/亿) follow the product language via
  `toIntlLocaleOrEn` / `formatCompactNumber`, never the host OS locale.
- Prefer shared primitives from `src/components/ui` over private replacements. Editable
  controls fill with `bg-input-field`, never `bg-input`; gray means disabled
  (`disabled:bg-muted`). Primitive rules: [src/ui/AGENTS.md](src/ui/AGENTS.md).
- Collapsed local-project and GitHub-repository rows count fresh Session/child-Tab
  activity (including pinned Sessions) at the row end, before actions. Show at most
  two items: permission > unread > active; combine mixed remaining states as `+N`.
  Omit single counts; initializing uses running. Expanded/removing groups hide the
  aggregate. Preserve disclosure and Session end-slot status. See the
  [draft contract](../../specs/collapsed-project-activity.zh.md).
- `PlatformContext` intentionally has no default. Cloud-shaped component tests use
  `tests/test-platform.tsx`'s `TestCloudPlatformProvider`; plain-module tests install
  and remove the exact platform port they need.
- Shared UI accesses optional hosted operations only through descriptors in
  `src/lib/cloud-api-operations.ts` and `@lody/platform/react`. Never import generated
  backend declarations or call a hosted database directly.
- A descriptor marked `public` can run before authentication and must expose only an
  intentionally public or narrowly token-scoped DTO.
- Renderer and worker builds that cannot use native top-level await must use
  `vite-top-level-await-fixed.ts`. Do not bypass its audited-version assertion.
- System theme state, persistence, and browser preference tracking are owned by
  `next-themes`. Keep Lody's wrapper focused on preview state, fixed VS Code theme
  application, and the Electron native-theme bridge.

## Rules shared by callers

Before changing crash recovery, diagnostics, localStorage cache keys, file preview,
Code Collab, file/diff caches, or Electron IPC typing, read the corresponding section
of [src/lib/AGENTS.md](src/lib/AGENTS.md). These contracts bind all UI, hooks, and
provider callers, not only files under `lib/`. Recovery must preserve auth/preferences
at cache-clear level; local file routes must never silently fall back to cloud.

## Scoped rules

- Product surfaces, sidebar session rows, local projects:
  [src/components/AGENTS.md](src/components/AGENTS.md).
- Shared primitives, emoji picker, field colors, diff viewer:
  [src/ui/AGENTS.md](src/ui/AGENTS.md).
- Hooks: [src/hooks/AGENTS.md](src/hooks/AGENTS.md). Workspace runtime, transports, and
  presence: [src/providers/AGENTS.md](src/providers/AGENTS.md).
- Sessions, mobile, chat, mentions, tasks, onboarding, settings, and Codex reset
  forecast each own an `AGENTS.md` under `src/components/`. Commands and shortcuts:
  [src/lib/commands/AGENTS.md](src/lib/commands/AGENTS.md).
