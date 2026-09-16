# Secret Post Office: one-week playable E2EE tutorial

Status: draft
Translation: current

[中文](e2ee-playable-tutorial.zh.md)

## 1. Scenario, goal, and scope

Players exchange secrets with Alice and Bob on a pixel-art stage, attempt forged operations, compare different views, then revoke, rotate, and recover a device. The surface world tells character stories; the optional technical lens explains the same events using actual signatures, verification, storage, and networking. This specification supersedes the tutorial's earlier nine-level, Three.js, full-town scope, not E2EE protocols or the independent demo's security requirements.

The target is five working days and a 10–15 minute local experience, not measured delivery or usability results. Beginners need not read the whitepaper or use a terminal after an operator starts `pnpm demo:e2ee`. Accessibility to children and older adults remains to be tested.

Develop in the current repository and branch, in `packages/e2ee-demo`, using real BrowserSession, E2EE core, Streams CRDT, and Node/official SQLite Riverrun. Do not create another repository or long-lived development worktree, integrate Lody product code, or change cryptographic/authorization semantics.

| Required this week                                                                  | Retained outside dedicated story levels                                                            | Explicitly excluded this week                                                                          |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Four levels, one stage, real peer workflows, lens, resumed progress, keyboard/touch | Flock, content snapshots, existing role/device operations and fault tools through free experiments | Three.js, free movement, physics, inventory, scoring, voice acting, general game framework             |
| Actual signature and permission rejection, public-digest divergence experiment      | Existing protocol, host, pending and browser regression tests                                      | New permission-snapshot onboarding, full malicious endorsement, machine pairing/execution, Passkey PRF |

Full whitepaper coverage is not a one-week completion condition. Label missing capabilities as explanatory or not integrated; animation cannot count as executed validation.

## 2. One-screen stage and interaction

Desktop: four-level progress and restart at the top, a fixed Alice–post office–Bob stage in the center, the current actor emphasized, a task of at most two sentences and one primary action below, and an optional lens on the right. A new Carol device replaces the right seat during recovery instead of adding another column.

On narrow screens switch seats rather than squeeze three columns; expand the lens below the stage. Keep controls in reading order and reachable with zoom or a software keyboard. Use readable sans-serif Chinese text. Pixel lettering is only for short decoration, never controls, evidence, or errors.

Loop: question → optional prediction → real operation → observed result → optional lens → next step. Predictions are skippable and unscored; explain wrong predictions without blocking. The tutorial may perform mechanical setup, but must identify the roles it is driving and never silently transfer private keys between actors.

No manual walking, precise dragging, or simultaneous two-seat interaction is required. Stamping, delivery, and unlocking are feedback, not proof that an operation succeeded.

| Surface object                 | Technical meaning                      | Misleading implication to avoid               |
| ------------------------------ | -------------------------------------- | --------------------------------------------- |
| Alice/Bob resident             | User identity                          | Every user has an omnipotent root private key |
| Their computer/phone companion | Independent device and keys            | Devices clone the same private key            |
| Personal stamp                 | Device signing private key             | It decrypts content or is handed to members   |
| Public stamp-check card        | Signing public key                     | A printed name proves real-world identity     |
| Room key K0/K1                 | Org epoch key                          | Possession grants management authority        |
| Recipient-specific lockbox     | Encrypted key envelope                 | The post office handles the plaintext key     |
| Bound and stamped book         | Ledger and previous hash               | A hash alone proves permission or freshness   |
| Emergency unit R               | Registered, restricted recovery device | Old-computer clone or universal administrator |

The terminology switch adds names such as “signature book · Ledger”; it does not replace all familiar labels.

## 3. Modes and provenance

**Teaching seats** are the default: one page drives Alice and Bob with independent keys. Storage is namespaced by tutorial run, seat, and account, separately from existing demo data. Label it “This page plays both people; it is not device security isolation.” Same-origin code can access both sides; a localStorage prefix is not a security boundary.

**Independent-device mode** uses separate browser profiles, browsers, or isolated test contexts. Another ordinary window usually shares storage and must not be called isolated. Display public device fingerprints to expose accidental identity reuse.

Comparison sources are server, teaching transfer, or a user-confirmed independent channel. The first two can report matching digests but never independent verification. The independent route requires material actually obtained from an authenticated other member; pasting alone does not establish provenance. Do not offer a button that promotes a server note into an independent note.

Record comparison scope: Org, position, head, state digest, and peer. After state changes retain “previously checked at N,” not permanent safety. Do not select a winner on equal-position conflict; different positions require synchronization or a common position. Rechecking the original endorser is not additional independent corroboration, but do not teach that creators are inherently untrustworthy.

## 4. Four levels and their completion conditions

### G1 The curious postman: admitted, but still unable to read

**Question:** “Does holding the letter mean the postman can read it?”

1. Start two seats. Alice creates a room and writes a synthetic secret in the diary.
2. Open the post office counter to inspect actual stored/transmitted ciphertext. Show size and routing labels: E2EE does not hide all metadata.
3. Bob signs a join request; Alice checks and approves it. Both verify the actual admission ledger state. Bob's attempt to read still fails without a key: “You are on the list, but the key has not arrived.”
4. Alice sends an envelope to Bob's public key. Bob opens it and reads the original text. Do not copy Alice's key Map to implement the effect.

**Lens:** admission, envelope delivery, and decryptability are separate events. Show device public keys, ledger position, envelope digest, and actual read outcome.

**Errors:** failed requests, CAS conflicts, or missing envelopes remain at the current step with retry/explanation. Animation cannot unlock the next level.

**Evidence:** separate clients accept the same admission state; Bob decrypts Alice's text through the real stream. The post office view cannot read endpoint private keys. Plaintext-marker searches are supplementary, not a substitute for actual encryption/decryption.

### G2 The fox's stamp: valid signatures are not permission

**Question:** “Can a convincing stamp write in the book?”

1. In an isolated synthetic experiment room, change the body of a genuinely signed record and pass it to the original verifier. Show actual rejection and no verification-state advance.
2. Bob signs a forbidden action with his real key, such as promoting himself. Show the actual permission rejection. If prepare rejects first, say so rather than inventing an HTTP exchange. Host attack tests may separately use low-level canonical encoding to construct a validly signed forbidden operation.
3. Contrast “invalid signature” with “valid signature, insufficient permission.”

**Lens:** prior role, device eligibility, signed body, and rejection boundary. Do not invent detailed backend error categories when only a generic result is available.

**Errors:** an expected security rejection differs from infrastructure failure. A disconnected network does not prove signature validation worked. If the invalid operation succeeds, stop and report an implementation defect.

**Evidence:** actual verification rejects both cases for their respective reasons; permissions do not increase. Do not corrupt the main story ledger or weaken the host's control-write allowlist.

### G3 Two different slips: is the post office's word enough?

**Question:** “What if the fox and postman show you misleading slips together?”

1. Export notes containing position and state digest from real clients. Normal server relay may match, but remains independently unverified.
2. In the isolated divergence experiment, intercept an actually exported public note, change its state digest at the same position, and feed it to the real comparison API. The lens explicitly says this is a modified claim, not a successfully forged valid ledger fork.
3. One side's slip cannot establish global agreement. Independent exchange exposes the conflict: “The two claims differ. Do not continue yet.”
4. Compare the unmodified real notes. Teaching transfer completes the demonstration only; independent-device mode may report “independently checked at N” only with actual provenance checking.

**Optional prediction:** different positions alone do not prove an attack. Show actual pending-sync instead of a conflict warning.

**Boundary:** an inviter and server can mislead a newcomer through a dishonest endorsement. Without independent material from an honest peer, detection may be impossible. This week implements public-note divergence only, not full malicious permission-snapshot endorsement, a valid fork, or key transparency.

**Evidence:** actual equal, equal-position conflict, and different-position results have correct provenance labels. Conflicts are not resolved automatically; server and teaching copies never receive checked status.

### G4 Recovering access without erasing memory

Present two short segments, not revocation, rotation, and recovery as one action.

**G4a A new lock does not erase memory.** Bob reads and retains an old secret. Alice removes Bob; show committed revocation separately. Rotate through the real workflow and confirm it before writing a new secret. Bob can still read his old local content, but actual decryption of new ciphertext with only the old key fails. Host read rejection and cryptographic decryption failure are separate results. Test the latter with a copy of actual new ciphertext supplied by the isolated experiment, not weakened host authorization. Do not show new-content confidentiality before rotation.

**G4b A new computer, not an old clone.** At this segment's current state, Alice creates/checks recovery material, exports a file, confirms it was saved, and closes the original session. Restore in a new isolated context using the file and persisted state. R must actually authorize a new personal device with a different public key; it must read the level's existing content without sharing the original session's key objects.

This week promises only that bounded recovery demonstration. It does not add long-lived cloud recovery delivery or claim that immediate restore proves recovery across arbitrary future rotations. If the existing file contains then-current epoch material, the lens names those material categories without exposing secret values. Old-file recovery across epochs, undelivered R keys, PRF, or restored management rights follow actual implementation capability and remain explicitly unverified/not integrated otherwise.

**Errors:** corrupted files cannot unlock. Keep already admitted state inspectable after failure; do not fake re-admission. Use reproducible synthetic data. “Closing” cannot secretly retain the original key provider for the recovery client.

**Evidence:** separate revocation/rotation states; old-key failure on new ciphertext; a different device restored through the file route reads the secret. Explain that loss of every device and recovery method can lose old secrets but need not prevent account login or creating another Org. Product login is not implemented by this level.

## 5. Lens and evidence

Use one side/bottom panel, not a draggable lens, 3D cutaway, or general timeline player. Clicking an object or “Look inside” selects its operation; closing restores the previous context.

Three progressive layers:

1. Plain language: what happened and what is still missing, at most three sentences.
2. Steps actually observed: signing, persistence, transmission, verification, commit, and decryption. Unobserved internals are labeled explanations, never invented timestamps or verification counts.
3. Evidence: operation, public keys/signatures, record digest, position, HTTP/library outcome, non-sensitive before/after summaries; public bytes collapsed. Identify the whitepaper topic and implementation entry point.

A thin event may contain runId, actionId, actorDevice, operation, boundary, outcome, recordHash/position, and publicEvidence. These are UI correlation identifiers, not new wire fields or ledger operation IDs. Events come from real results, not animations. Never put whole Sessions, private/epoch keys, recovery files, or full plaintext into generic traces, logs, or error reporting. Show secrets only on demand in the owning endpoint's scene.

Action states are idle → running → confirmed / rejected / unknown. Business phases remain separate: confirmed admission may still wait for a key. Unknown retains exact pending bytes and uses existing recovery APIs; retry does not re-sign. Recompute story prerequisites from actual devices, ledger, keys, and retained evidence on reload; checkboxes cannot grant authority.

Review displays summaries of completed events, not database time travel. Replay creates an isolated synthetic run; deleting a prior run requires an explicit scoped target and confirmation, never clearing all origin data.

## 6. Visuals, motion, and accessibility

Use one fixed pixel-art stage and a small local, licensed asset set; envelopes, keys, and stamps use SVG/CSS. Keep React/Vite. Base UI may supply needed Dialog/Tabs/Switch primitives; do not import an entire component wishlist. No game engine or Lody UI package. Bundle assets locally, avoid runtime font/CDN dependencies, and record asset licenses/sources briefly.

Paper `#F6F1E4`, ink `#1C1915`, vermilion `#C23A2B`; the lens uses dark-blue blueprint styling. Accent the current action/check, not an entire error screen for wrong predictions. Measure contrast instead of assuming tokens comply. Epochs have color plus number and shape.

Only delivery, stamping, and unlocking need short motion. Unknown results leave an envelope awaiting confirmation. Animations can be skipped; reduced-motion shows the result directly. Animation neither pauses networking nor decides status. No mandatory drag/precision action. Provide focus, readable names, error announcements, and touch controls.

Validate 390px and 1280px widths, 200% zoom, a keyboard walkthrough, and reduced motion. Chinese text must not clip. Long hashes wrap/copy without displacing primary controls. No WebGL or discrete GPU requirement.

## 7. Minimal structure

```text
Player → tour controller → BrowserSession / experiment adapter → existing core + HTTP + Riverrun
                                    ↓ actual results
                              limited public events
                              ├─ pixel stage
                              ├─ lens
                              └─ level acceptance
```

Split tour, stage, inspector, copy, and styles inside existing `src/ui` as needed, not as a framework mandate. Free experiments reuse existing actions. Change BrowserSession only to bridge real behavior; never reimplement protocols in UI. Missing foundational safety is a separate fix, not a hidden one-week scope expansion.

Fault/divergence adapters operate only in isolated experiments and pass actual bytes into original verification/comparison APIs. URL parameters can display panels; host testMode requires explicit startup. Do not reintroduce control-stream bypasses.

Same-page Sessions exchange public material and ciphertext through normal paths. The post office renderer must not directly inspect endpoint secrets. Tutorial storage is separate from existing manual demo accounts. Prefixing localStorage does not establish cross-tab mutual exclusion; if unsupported, explicitly limit a run to one active controller page.

Keep stable IDs where useful, on actual usable controls only. No hidden legacy buttons for Playwright. Update tests to scoped semantic locators where interactions change. Keep protocol tests; the full tutorial browser path is mandatory.

## 8. Acceptance and whitepaper coverage

| ID  | Trigger and required observation                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | G1 completes with distinct device keys and real envelope/stream decryption, not memory copying                                                    |
| A2  | Signature/permission rejection identifies the actual boundary, does not elevate roles, and is not confused with infrastructure failure            |
| A3  | Server/teaching provenance never becomes independently checked; same-position conflicts differ from position lag                                  |
| A4  | Old keys fail to decrypt new-epoch ciphertext while old content remains readable; upload rejection is not decryption proof                        |
| A5  | After closing the original session, an isolated client restores a different device from the file and reads the level's content                    |
| A6  | Refresh/interruption preserves saved identity/pending; progress does not authorize; failed persistence prevents CAS                               |
| A7  | Lens evidence belongs to the same actual action and contains no private/recovery secrets in generic traces                                        |
| A8  | Keyboard, touch, reduced motion, and 200% zoom keep primary actions reachable and errors understandable                                           |
| A9  | Free experiments and prior tests remain; startup is unchanged; replay affects only isolated synthetic data                                        |
| A10 | Completion distinguishes executed, explanatory, and unintegrated capabilities; it is not a production audit or complete whitepaper implementation |

G1–G2 exercise identity, signatures, invitations, and confidentiality; G2–G3 ledger comparison and trust boundaries; G4 revocation, rotation, and bounded file recovery. Short explanations cover metadata, directory identity, the 15-minute dependency, collusion, and absence of automatic post-compromise recovery. Flock, content snapshots, and existing CAS/lost-ACK tests remain free experiments. Machines, PRF, full snapshot onboarding, and long-lived recovery delivery are not this week's hands-on coverage.

Run existing `pnpm --filter @lody/e2ee-demo check` and `pnpm --filter @lody/e2ee-demo test:browser`, adding the four-level path and A1–A10 counterexamples. Pair rejection tests with valid controls. Do not mock away HTTP/SQLite, crypto objects, or browser isolation. Use injected clocks/signaled pauses, not sleeps. Missing browser dependencies mean unverified, not success via a source-file existence assertion.

Have a non-implementer rerun the README and conduct a human walkthrough: next-action clarity, signature versus decryption, revocation versus memory, and a dishonest server. Record participant count/observations; do not claim all-age usability. Completion reports run/revision, actual checks, and skipped/explanatory items without secrets.

## 9. Five-day plan and scope freeze

| Day | Deliverable                                         | Exit condition                                                                | Status |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| 1   | Four scripts, one stage, evidence/state mapping     | Each action names its actual API, gap, and outcome; no hidden protocol change | [ ]    |
| 2   | G1 and lens end to end                              | Real invitation/envelope/decryption; honest isolation label                   | [ ]    |
| 3   | G2/G3 and failure outcomes                          | Actual rejection, provenance, conflict/lag tests; feature freeze              | [ ]    |
| 4   | G4, refresh resume, full path                       | Bounded file restore, post-rotation confidentiality, pending regressions      | [ ]    |
| 5   | Automation, independent review, walkthrough, README | Fix blockers, record limits/evidence, no new feature work                     | [ ]    |

After day 3 add no levels or capabilities. Cut decoration, motion, and explanation depth before real validation, recovery correctness, or provenance. Report foundational defects honestly; explanation cannot substitute for required hands-on completion. If gates fail by day 5, hand off explicit unfinished work instead of marking success to meet a date.

## 10. Sources, status, and work log

Inspect [demo README](../packages/e2ee-demo/README.md), [ledger specification](e2ee-ledger.zh.md), and [independent demo decision](../.agents/notes/proposed/architecture/2026-09-16-e2ee-independent-demo.md). Semantics follow Lody Security Whitepaper v0.11's identity, comparison, revocation, recovery, and boundaries. This document does not copy private deployment material or change protocol specifications.

Implementation reference baseline: `d20c2f25`. This change records design only; game implementation, model checking, and usability acceptance are not complete. Before full implementation, map A1–A10 to finite UI-state/provenance combinations and end-to-end tests; this is not a cryptographic proof.

Append short work entries here: date/revision, completed work, discoveries/constraints, actual commands/results, unverified items, plan suggestions, and next step. The table is the sole tutorial progress record; do not copy full conversations/consoles. Confirm new permission/trust changes; do not re-ask settled scope for ordinary visual implementation.

- Initial entry: four-level one-week design recorded, replacing the tutorial's nine-level/Three.js scope; not implemented and not complete whitepaper coverage.
