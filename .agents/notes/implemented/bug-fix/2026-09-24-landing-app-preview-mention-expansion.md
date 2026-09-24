# Landing app preview blanked by composer mention expansion

Status: implemented
Translation: current

[中文](2026-09-24-landing-app-preview-mention-expansion.zh.md)

## Abstract

The public landing stopped rendering its product stage: only the seabed showed
below the hero. `ChatComposer` gained `useMentionPromptExpansion` in #797, whose
Agent Role lookup calls `useVisibleMachineMetas` → `useAuthenticatedConvex`. The
public site has no `AuthenticatedConvexProvider`, so the composer threw and the
preview's `OptionalEnhancement` boundary removed the whole replica. A site-side
alias now replaces `@/components/mentions/mention-expansion` with an identity
expansion, and the production static check asserts that the preview mounts.

## Decision and evidence

- Reproduced on the dev server (Chrome, 1440×900): the console reported
  `useAuthenticatedConvex must be used within an AuthenticatedConvexProvider`
  from `ChatComposer`, and the stage was empty.
- Shimmed at the site boundary, like the existing `use-online-machines` shim,
  rather than making the product hook tolerate a missing provider: the app's
  contract that mention expansion runs inside the authenticated provider stays
  explicit, and the preview never sends a prompt, so expansion has nothing to do.
- The `CombinedMentionTextarea` shim also swallows the composer props added since
  it was written (`currentSessionId`, `draftKey`, `mentionActionsRef`, …), which
  React was warning about as unknown DOM attributes.
- `scripts/verify-static-browser.mjs` adds `landing app preview mounts` for `/`
  and `/zh`. Removing the alias and rebuilding makes both cases time out; with
  the alias they pass.

## Verification and limits

`pnpm --filter @lody/site-docs build` then `STATIC_TEST_PHASE=faults` of
`test:static` passes 32 cases. A three.js `compileAsync` `isReady` page error
still appears once on the dev server only (unchanged `underwater-background.tsx`,
consistent with a StrictMode double mount); the production hydration checks
record no page errors, and it is out of scope here.
