# Secondary pages: one quiet layout whose connector shows the state

Status: implemented
Translation: current

[中文](2026-10-18-secondary-page-pattern.zh.md)

## Abstract

The pages a person lands on from outside the app — an invitation, a device
code, an email link, a checkout return, a GitHub callback — were each a
different centered card with their own layout and redirect habits. They now
share one restrained layout, `SecondaryPage`: two small tiles (the outside party
and Lody) joined by a connector that carries the shared state, a two-tone title, one
optional recessed well for a value, and at most two equal-width actions. The device
code field is a local exception: its eight-character segmented display animates entry,
verification and errors while one real input preserves paste and one-time-code autofill.
The other shared page decoration stays quiet. GitHub install callback landed first, followed
by the invitation, device authorization, email-verified and checkout-return pages. Each
page keeps its own state names, copy and callbacks; the code feedback respects reduced
motion preferences. The migration was not rendered for a design review, and the prototype's
account-switch footer, sub-400ms "arrive" skip and auto-continue countdown rules are not
implemented.

## Problem

Read from `components/pages/*`: `accept-invitation-page.tsx` had six states with
their own eyebrow and badge; `device-auth-page.tsx` used a card with an alert and
a 10-second countdown back to `/`, although the person's next step is in their
terminal; `email-verified-page.tsx`, `desktop-checkout-return-page.tsx` and
`desktop-github-install-page.tsx` each drew their own centered card, and errors
everywhere were free text in a separate block. The login page owns the product's illustrated moment; these pages should not compete with it.

## Reference

Headless captures of public pages on 2026-10-18: Cursor's desktop sign-in
handoff (`cursor.com/loginDeepControl`) is a left-aligned column of mark, short
title, one line and two equal buttons (grey cancel, black continue) on a plain
ground; Cursor's authenticator uses an ink title over a grey subtitle; xAI's
sign-in is a centered title and outlined pill buttons in wide whitespace; Linear's
error state is mark, title, one line and two pill buttons. None uses a card.

## Design

- **Layout:** a 360px left-aligned column slightly above centre; no card, border
  or illustration.
- **Mark:** left tile is the outside party (GitHub, terminal, envelope, card,
  workspace); right tile is Lody.
- **Connector as state:** arrive — dotted lines flow and three dots pulse in the
  node; ask — dotted lines and an arrow; done — both lines solid, node filled with
  a check; blocked — node outlined in the destructive colour with a cross, the
  right tile faded. That cross is the only colour on the page.
- **Title:** line one is the fact in ink, line two the explanation in grey at the
  same size.
- **Well:** one optional recessed holder for a value the person reads or copies
  (the verified email, the invited address).
- **Content:** an optional free slot between the title and the actions. The device
  page uses it for an eight-character segmented code field backed by one real input;
  only this local control animates digit entry, verification and errors.
- **Actions:** secondary left, primary right, equal width; one action spans the
  row. A 12.5px line below holds expiry or a fallback.

## Implementation

`packages/components/src/components/pages/secondary-page.tsx` owns the layout,
its tokens and the connector. Consumers map their own states onto
`SecondaryPageState` and pass tiles, copy, actions and notes; no page changed its
public props, i18n keys, callbacks or accessible names.

- `desktop-github-install-page.tsx` first: `ask` while a deep link exists, else
  `arrive`, with Copy link and a 3s fallback line.
- `accept-invitation-page.tsx`: `loading`→arrive, `success`→done, `error`→blocked,
  the rest→ask. The role line and account-mismatch workspace line move to the note.
- `device-auth-page.tsx`: `success`→done, verifying→arrive, otherwise ask; its single
  `@lody/ui` input is visually presented as eight segmented cells around a separator.
  Paste and one-time-code autofill remain native input behavior; incoming characters are
  normalized to uppercase alphanumerics. Digit entry, verification scan and error feedback
  animate locally, with reduced-motion support. The form stays in the content slot.
- `email-verified-page.tsx`: done, with the email in the well and the countdown in
  the note.
- `desktop-checkout-return-page.tsx`: `success`→done, else ask.

Storybook covers `SecondaryPage` itself across all four connector states
(`src/stories/SecondaryPage.stories.tsx`); the existing page stories were kept.

## Alternatives considered

Both drafted earlier in this work and rejected by its owner:

- A ticket-shaped card with a 1-bit dithered seal between the two parties: still
  read as an ordinary form, and the dithered visual belongs to the login page.
- The whole page as one large sentence whose tense changes with the state, with
  persisting words sliding to new positions: rejected without further detail.

## Evidence and limits

Prototype: a Design canvas artifact (interactive prototype, rules, a 5×4 page ×
state matrix, phone width in light and dark). Synthetic data only.

Landed evidence: `secondary-page.tsx` plus the five consumers above; the device page keeps
one real input behind its segmented code display and its Storybook states include formatted
pasted code. `accept-invitation-page`'s behavior suite passes unchanged, and
`@lody/components` typechecks except for two pre-existing errors in unrelated
in-progress files (`loro-sidebar.tsx`, `home-week-usage.ts`).

Limits: the migrated pages were not rendered for a design review, and the device page has no
behavior suite for paste normalization or animation timing. The prototype's account-switch
footer ("signed in as … · switch account"), the sub-400ms "arrive" skip, and the auto-continue
countdown that replaces the return hint (with a lighter fill and cancel-on-input) are not
implemented. The device and email pages keep their own countdown behavior; the device page's
"requested just now" and the email provider shortcut are still absent.
