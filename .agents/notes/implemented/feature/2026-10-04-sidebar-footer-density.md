# Compact sidebar footer controls

Status: implemented
Translation: current

[中文](2026-10-04-sidebar-footer-density.zh.md)

PR: [#1239](https://github.com/LodyAI/Lody/pull/1239)

## Abstract

The desktop workspace trigger was 32px high beside 24px action buttons, making
its hover area appear disproportionately tall. All four controls now share the
UI primitive's 28px small size, while avatars remain 20px and action glyphs are
16px. Mobile retains 48px touch targets. Browser measurements and screenshots
cover the component scene; full application verification remains limited by
the checkout's existing dependency and type errors.

## Decision

[LoroSidebar](../../../../packages/components/src/components/loro-sidebar.tsx)
owns the footer composition. Desktop controls use ghost Buttons; their size,
hover and focus come from the primitive. The static local identity uses the
same height without becoming a button. A flex wrapper prevents the inline
button's baseline line box from adding extra height. The active Archive action
uses a separate selection surface and `aria-current`, keeping its button's
visual contract intact. Mobile glyphs have their own 20px holder inside 48px
targets rather than overflowing the primitive's 16px glyph holder.

Every adjacent pair of desktop controls has a 4px gap, including workspace
and Help. Browser coverage measures all three gaps. At the same sidebar width,
the actions and their workspace gap occupy
8px more horizontal space than the original footer, so long names can still
truncate. Making every control 32px would retain the bulky footer;
reducing every control to 24px would leave only 2px around the workspace avatar.
The shared small size balances density and pointer targets.

This supplements the [action-order decision](2026-09-26-sidebar-footer.md) and
replaces only the active-footer treatment in the
[reading-contrast decision](2026-09-24-reading-contrast.md).
Intent lives in the [footer Spec](../../../../specs/sidebar-footer.md), which
remains a draft.

## Verification and limits

The existing sidebar and workspace-identity suites cover selection, syncing,
static identity and footer destinations; all 24 tests pass. Both Playwright
footer checks pass. Browser coverage belongs in the
existing sidebar layout suite, using the
[footer stories](../../../../packages/components/src/stories/SidebarFooter.stories.tsx)
for light/dark palettes, long names, syncing and static identity at interface
font sizes 12, 14 and 18. Mobile coverage checks real touch targets and menus.
Playwright captures before and after from the same dark story, viewport,
device scale and workspace hover state; generated images stay ignored under
`artifacts/sidebar-footer/`.

The before controls measured 32px and 24px, with a 41px footer. After controls
measure 28px with a 37px footer, including Chromium's rounded separator width.
Scoped lint and root `pnpm format` pass. Documentation checks add no errors to the
existing baseline. Full `pnpm check` stops on the missing `fumadocs-mdx` tool;
component type checks encounter unrelated document-preview dependencies and existing
Markdown/runtime type errors. No Electron application launch or human Spec
approval is claimed.
