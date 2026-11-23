# Login page: inset dithered visual, equal sign-in methods, and a "Last used" badge

Status: implemented
Translation: current

[中文](2026-10-17-login-inset-visual-last-used.zh.md)

## Abstract

The login page was a small centered card whose GitHub button was filled while the
other providers were outlined, which read as a recommendation rather than a choice,
and it gave a returning user no hint of which method they had used before. The
page is now a two-part window: an inset surface on the left draws the Lody
jellyfish as a 1-bit ordered-dither shader with the product tagline, and a column
on the right holds the sign-in methods as one group of equal secondary buttons,
with email as a ghost entry beneath them. The method this device last completed is
marked "Last used", stored as a device preference that names only the method. On
arrival the dither develops outward from the centre while the column's parts rise
in one after another, so the page does not appear all at once. Switching between
OAuth and email does not resize the lower group: CSS reserves stable header and
panel tracks, and only the views cross-fade and slide within those tracks. The
visual is decoration: without WebGL, or under reduced motion, it degrades to the
plain surface or one still frame.

## Layout

- `login-page.tsx` owns the shell in StyleX: a grid of the inset visual
  (`radius.large`, a 5% ink mix off the page background) and a 360–440px sign-in
  column.
- Below 860px wide the two stack: the visual becomes a top block
  (`clamp(200px, 42svh, 360px)`) and the column keeps its group at the bottom,
  within thumb reach. Opening the email form folds the block to zero height so
  the fields and the on-screen keyboard have the room. A narrow window shorter
  than 600px (a phone on its side) drops the visual. The page pads by the
  safe-area insets and uses `100dvh` so native shells and mobile browser bars
  do not cover it.
- The column is anchored at both ends: the mark at the top meets the visual's top
  edge, and the title, methods and legal notice sit at the bottom on the
  tagline's baseline. The lower group is ordinary CSS with a 474px minimum
  footprint. Its header is a three-row grid (36px back slot, 34px title, and at
  least 42px for a two-line description), while the active-view slot is at least
  246px and bottom-aligns its child. OAuth's 216px method list and the 246px email
  form therefore share the same panel bottom; absent back/second description
  lines retain their grid tracks. OAuth and email keep identical outer geometry
  at desktop, stacked, and phone widths, so no measured height, inline style,
  ResizeObserver, or height spring exists. Larger states can still exceed the
  minima. Email sign-in/sign-up uses one coordinated spring: the name row expands
  while its negative margin absorbs the parent gap, the forgot-password row owns
  its 6px inset while collapsing, and fixed header tracks cross-fade title and
  description copy. This keeps external gaps from appearing on mount or
  disappearing only after exit. The back control moved from an absolute corner
  button into the header as a ghost `Button`.
- Every provider is `variant="secondary" size="large"` with its icon and label
  starting at the button's edge, so rows line up without the former hidden
  label-measuring element. The "or" divider and its locale key were removed.
- All panels (email form, verification, desktop renderer, browser handoff) keep
  their behaviour and Tailwind internals; only the verification icon lost its
  accent tint so the page stays neutral.

## The visual

`login-dither-visual.tsx` ray-marches the jellyfish and thresholds it against an
8×8 Bayer matrix at 3 CSS px per cell. It reads paper and ink from its
container's computed `background-color` and `color` (resolved by painting them,
since a `color-mix` serializes as `oklab()`), so it follows the theme. The
tagline's measured box (passed as `keepClearRef`) stays free of dither, so it
stays legible at any size, and the jellyfish sits right of centre on wide
surfaces and centred on square or tall ones. Its entrance scales the dither
density by a radial reveal over 1.6s; the column staggers brand, header,
methods and legal notice with framer-motion, and the tagline follows. Reduced
motion skips both and shows the final state. The canvas is sized in whole cells
and shown at exactly 3px per cell rather than stretched to the container, and a
resize redraws inside the ResizeObserver callback: a stretched canvas made each
cell a changing fraction of a pixel wide, so the pattern swam while resizing, and
waiting for the next animation frame presented one cleared, empty frame. It pauses while the document
is hidden, renders one frame under `prefers-reduced-motion`, and releases its
WebGL context on unmount. Without `WebGLRenderingContext` (jsdom, blocked GPU)
it draws nothing.

## Last used

`lib/last-login-method.ts` stores `github | google | apple | discord | email`
under `lody.auth.last_login_method` in `localStorage`. It is written only when a
sign-in completes: the OAuth return (`readAndClearPendingOAuth` resolving a
marker), native OAuth completion, and a successful email sign-in. A started but
abandoned OAuth attempt does not move the badge. It is a preference, so cache
clearing keeps it and sign-out does not clear it; it never names an account.
Storage that throws or holds an unknown value shows no badge.

Alternatives considered: deriving the method from the session (better-auth does
not expose which provider created the current session to the client), and a
cookie (would travel with every request for a purely local hint).

## Verification

`tests/login-last-used-method.test.tsx` covers: no badge on a fresh device, the
badge after an OAuth round trip, no badge after an abandoned attempt, email after
a successful email sign-in, and an invalid stored value. Storybook adds
`Last Used (Google)` and `Last Used (Email)`. The focused suite passes all five
tests. A headless Chrome check against the live Default story at 1000px, 850px,
and 390px widths found identical geometry before, during, and after
OAuth/email/OAuth switching: the body stayed 474.19px, header 128px, active slot
246px, and title plus legal-notice coordinates did not move. The body had no
inline height. Switching email sign-in to sign-up exercised the intentional
larger state: its existing name-field reveal grew the ordinary body continuously
from 474.19px through 504.45px and 535.17px to 538.19px while the bottom stayed
fixed. The screen recording's first email-mode switch exposed two discrete CSS
gaps around the animated rows; after moving those gaps inside the spring, the
forward browser trace was 474.19px → 490.86px → 512.56px → 526.27px → 537.61px,
with a 539.56px elastic peak before settling at 538.19px. The reverse trace
settled continuously from 538.19px to 474.19px. Reversing only 100ms into the
first spring retained velocity (521.91px → 528.22px → 474.81px) rather than
restarting or jumping. Title and submit copy cross-faded on the same timeline.
Package typecheck is
currently blocked by pre-existing errors in `loro-sidebar.tsx` and
`home-week-usage.ts`. A full package-test attempt exceeded the 120s command limit
after surfacing an unrelated existing sidebar-width assertion (`-280px` expected,
`-300px` received).
