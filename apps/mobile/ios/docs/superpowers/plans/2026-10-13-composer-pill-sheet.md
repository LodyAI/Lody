# Composer: pill at rest, full-width sheet when active

Spec: the approved Design canvas https://claude.ai/artifact/ULgdh4c5mCNKcfWw3zoxNw,
page "Round 2", boards E-Flow, E-Rest (option 2), E-Focus (option 1), E-Expand,
E-States, E-RestAttach (option 1), E-Queue (option 1), E-Notice (option 2).

## Global Constraints

- All work in `apps/mobile/modules/lody-kit/ios/Chat` and its hosts; native only, no RN keyboard avoidance.
- Keep normal signing. Build with `pnpm verify:build`, run checks through `pnpm verify:simulator`.
- UI Verify in English only, light + dark. Every changed behavior gets a check in `apps/mobile/verification/ui`.
- Hosts that embed `ChatComposerView`: chat (`LodyChatView`), new-session form (`CreateSessionController`), Share Extension (`ShareViewController`). Each must still work.
- No commits unless the user asks (user rule overrides the skill's commit steps).
- Zero comments unless they explain a non-obvious constraint.

## Target behavior (from the spec)

Resting (not first responder):

- One glass capsule, 16 pt side inset, 48 pt tall: `+` on the left (no background), placeholder or the draft's first line truncated, nothing else.
- Send appears at rest only when there is content (text or attachments). Stop appears while running. Loading spinner while sending.
- Attachments at rest: stacked 28 pt thumbnails inside the capsule before the text; placeholder becomes "Add a message".
- Quick-reply chips above the capsule (unchanged rules). Order above the capsule, top to bottom: notice, chips, queue card.

Active (first responder):

- The capsule becomes an edge-to-edge sheet resting on the keyboard: top corners 28 pt, no side inset, no bottom gap.
- Inside, top to bottom: grabber (chat only), mention results (when open), attachment row (48 pt thumbnails, 6 pt gap, remove badge inside the corner), text (minimum 5 lines), format bar (full screen only), toolbar 48 pt: `+` `@` permission … model, send.
- Grabber drag up past the snap point → full screen with the format bar; the bar's height and opacity follow drag progress. Drag down from full screen → default. Drag down from default → resign (back to the capsule). Tap/VoiceOver activate on the grabber toggles full screen. The expand button is removed.

### Task 0: Branch and before-baseline

- [ ] `git switch -c feat/composer-pill-sheet`
- [ ] Build main's current state: `pnpm verify:build`
- [ ] Capture before-evidence: `create-parity`, `composer-glass`, `composer-glass-chat`, `composer-fullscreen` into `.artifacts/before-<case>`.

Expected: every case PASS on the old build; screenshots saved for parity review.

### Task 1: Pill ↔ sheet surface

- [ ] Rewrite `composer-glass.py` for the new geometry (RED on the old build): at rest Add is inside the capsule and no send is visible when empty; focused input spans the full composer width, sits on the keyboard, Add and Send share the toolbar baseline.
- [ ] Replace `ChatComposerLiquidGlassSurfaceLayout` with a pill/sheet layout; remove the separate attach surface.
- [ ] Send visibility rule at rest.

Test: `composer-glass` and `composer-glass-chat` PASS light + dark.

### Task 2: Resting draft and attachments

- [ ] New check `composer-rest-draft`: type a two-line draft + paste a file, dismiss; capsule stays 48 pt, shows the first line, the attachment stack and Send; quick replies hidden.
- [ ] Single-line truncation at rest, attachment stack view, "Add a message" placeholder string.

Test: `composer-rest-draft` PASS light + dark.

### Task 3: Attachment row inside the sheet

- [ ] Restyle `ChatAttachmentBar` to 48 pt thumbnails, 6 pt gap, badge inside the corner; host it inside the sheet above the text.
- [ ] Picking from `+` at rest focuses the composer so the overlay hands off into the sheet's row.

Test: `attachment-motion-chat`, `attachment-overlay-chat` PASS.

### Task 4: Mention results inside the sheet

- [ ] Host `ChatMentionPanel` inside the sheet with the sheet's material; the text area yields height.

Test: `mentions` (and `mentions-production` if offline-capable) PASS.

### Task 5: Grabber → full screen

- [ ] Rewrite `composer-fullscreen.py` for the grabber (drag up, release past snap → format bar visible; drag down → default; tap toggles; send collapses).
- [ ] Grabber view + pan, progress-driven input height / format bar / dim; remove the expand button.

Test: `composer-fullscreen` PASS light + dark, with video.

### Task 6: Stack order above the capsule

- [ ] Order notice → chips → queue → capsule.

Test: the existing queue / notice checks PASS; screenshot both states.

### Task 7: Other hosts

- [ ] New-session form: sheet without grabber; `composer` and `create-parity` checks; compare with the before-baseline.
- [ ] Share Extension compiles and renders the same composer.

Test: `composer`, `create-parity` PASS; Share Extension target builds.

### Task 8: Whole-branch verification

- [ ] `pnpm check`, `pnpm bundle`, full `pnpm verify:build`, rerun every check touched above.
