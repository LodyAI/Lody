# Mobile first-run guide hands setup to the computer instead of linking out

Status: implemented
Translation: current

[中文](2026-09-23-mobile-first-run-connect-machine.zh.md)

## Abstract

The mobile home screen's first-run surface (shown when the workspace has no
machines and no conversations) used to say only "Lody runs on your computer"
plus a button that opened the download page in the phone's browser — which
re-pitched the mobile app the user had literally just installed, and could
never move bytes to the machine that actually needs them. The card is now a
connect-a-machine guide built around the two artifacts a phone can hand to
another device: a copyable `npx lody daemon start` pill for the CLI path, and
a "Send to computer" system share sheet (AirDrop / Messages / Mail) for both
the command and the localized download link, with clipboard copy as the
universal fallback. The phone never navigates to the download page at all. A
three-step preview (machine appears → add a project folder → pick an agent)
closes the loop. The deliberate trade-off: all new label fields are optional
with Chinese defaults, so hosts that pass the original three strings still
render a complete guide — at the cost of component-level Chinese fallback copy
that the mobile host is expected to override through i18n.

## Decision

### Upgrade the existing empty state, do not add a route

The alternative investigated first was a dedicated onboarding surface — either
a new mobile route or a public `site-docs` onboarding page. Both were rejected:

- A separate route duplicates a surface that already exists and already owns
  the trigger condition (`showChatOnboarding`: no machines AND no conversations
  AND not loading). A second surface would need its own trigger logic and would
  drift from the real empty state it is meant to explain.
- A public site page can be reached only by leaving the app; the moment a user
  needs the guide is precisely when they are looking at an empty Chat tab.
- The public download page already owns platform detection and release
  metadata. The guide references it only as a *shareable URL*
  (`onboardingDownloadUrl`, fed by the same `getDownloadPageUrl` helper the
  desktop empty state uses), so release-channel changes cannot stale it.

### Why the phone must not open the download page

The first iteration kept a "Download Lody" button that opened
`getDownloadPageUrl` in the external browser — the same handler the desktop
no-machine hint uses. Two facts make that wrong on this surface:

- `site-docs/components/download-page.tsx` detects the platform from the UA
  and badges the matching card "Detected platform". On iPhone/Android that is
  the *mobile* card — the page spotlights the app the user already has, and
  the desktop downloads sit one scroll down in a second group.
- Even if the user reaches a desktop download on the phone, a `.dmg`/`.exe`
  in the phone's Files app does not reach the computer. The tap never crosses
  the device boundary.

The task underneath the button is a cross-device handoff, and the guide is
shaped around the insight that a phone cannot transmit anything — it can only
*display* something the user carries across themselves. So both cards lead
with the artifact as a typeable mono pill:

- **Command card** — `npx lody daemon start` in a large mono pill. Typing it
  on the target machine is the baseline path (22 characters, memorable);
  tapping the pill copies it (covers paste-into-SSH-client flows like
  Termius/Blink), and an icon-only share button pinned to the pill's trailing
  edge sends `command + link` in one `text` field.
- **Desktop card** — the share sheet is the interaction: a full-width
  labeled "Send to computer" button sends `{ url }` and AirDrop lands it
  directly in the Mac's browser, with an icon-only copy button pinned to its
  trailing edge — the same coupled row layout as the command pill, but with
  the primary/accelerator roles inverted. The URL itself is not displayed —
  a link's destination is a browser tab, so showing it as a typeable
  artifact added noise; only when `navigator.share` is absent does the pill
  (scheme-stripped display, `https://` on copy) appear as the fallback path.
  `onDownloadClient` was removed from the component and from
  `MobileHomeScreen` entirely — a callback whose only contract was "open the
  page" no longer has a caller on this surface.

The mechanism hierarchy follows the artifact: a command is something you
type, so the pill leads and share is the trailing accelerator; a link is
something you open, so share leads and copy is the trailing accelerator —
the same row anatomy, roles swapped. QR codes were considered and rejected:
they bridge computer→phone (the phone scans), which is the opposite
direction. An entrance animation (staggered spring + radar ping behind the
icon) was implemented and then deliberately dropped after review — the
guide renders statically; calm beats cute here.

### The command is the primary path, desktop app secondary

Docs and the CLI's own preflight (`apps/cli/src/commands/daemon-auth-preflight.ts`)
agree on the real journey: `npx lody daemon start` validates credentials, runs
device authorization in the visible terminal, opens or prints a sign-in link,
and waits — so a headless server's printed link can be opened on the very phone
showing the guide, which is already signed in. The desktop app is the friendlier
path only for the user's own computer. The ordering follows that: the command
card leads because it covers every machine class (server, VM, SSH host,
personal computer), while the desktop card covers exactly one.

The command pill copies through `writeTextToClipboard`
(`src/lib/clipboard.ts`), which already handles insecure contexts and missing
Clipboard API via a hidden-textarea fallback — the existing `CopyButton` in
`src/ui/copy-button.tsx` does not, so it was deliberately not used.

### "What happens next" closes the loop

The three numbered steps mirror the documented quickstart and exist to answer
the second question a first-run user has: "is this phone app going to become
useful?" They are preview text, not tracked state — no checklist machinery was
added.

## Verification

`tests/mobile-home-onboarding.test.tsx` renders the component in jsdom and
asserts observable behavior: the command pill copies `npx lody daemon start`
through a stubbed `navigator.clipboard` and flips to the copied label; the
guide renders no outbound `<a href>` at all (the phone never links out); the
command override renders verbatim; with `navigator.share` stubbed, the two
share buttons emit the correct payloads (`text` containing command + link for
the command path, `{ url }` for the desktop path); and the URL pill copies the
full `https://` link while displaying it scheme-stripped. `pnpm lint:i18n`
covers both locale files; `tsgo --noEmit` is clean for the package.

Visual acceptance: a temporary Storybook story rendered the pre-change card
(copied verbatim from git HEAD) beside the new guide in two phone frames;
the Playwright-captured screenshot (`mobile-onboarding-before-after.png` at
the worktree root) confirmed the layout in each iteration. The story and the
capture script were removed after capture.

Not verified: the share sheet on a real Capacitor build (the stub only proves
the gating and payloads); whether `navigator.share` absent + clipboard absent
leaves a usable path on exotic WebViews (`writeTextToClipboard` falls back to
`execCommand`, which covers the realistic remainder).
