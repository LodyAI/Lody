# iOS ask-user question sheet (#9)

## Contract

Normalize the upstream Lody elicitation, Claude askUserQuestion and Codex
requestUserInput metadata at the data-runtime boundary. Project the request kind,
source, questions, options, custom-answer policy and optional deadline alongside
the existing permission target. Keep the existing replica and permission-response
bridge; persist a selected outcome with the provider-specific answer metadata.
Use upstream answer keys (unique id, question text, header, then index), including
Codex's `{ answers: string[] }` response values. Validate every answer before a
write. Different answers to the same already-resolved request are conflicts.

## Presentation

The existing result-returning PermissionScreen hosts a dedicated question card
when its target is ask_user_question. This also handles a sheet opened before the
replica arrives and transitions between pending request types. Use the existing
HIG form sheet, transparent navigation, system close button and automatic scroll
and keyboard insets. Start at the large detent (including a target that resolves
late) so form navigation remains visible; retain the half-height detent for manual
collapse. One question per page keeps long prompts and free text usable
on iPhone. Show progress, prompt, single/multiple choice instruction, options with
descriptions/previews, and an optional native text input (secure for secret fields).
Use accessible 44 pt option buttons with explicit selected state, neutral system
colors and blue actions. These are answer controls, not simulated grouped rows.

Previous/Next retain drafts. Selecting an option does not submit. Submit is enabled
only once every question has an answer; custom text replaces selected choices as
on OSS. Submission disables editing; upload errors retain the draft for an explicit
retry with the same answer set. Answers become read-only after submitting because
the local replica has committed them before upload. Unrelated stream refreshes
keep an unuploaded answer pending; a different remote outcome takes precedence.
Changing request identity resets the card; identical replica refreshes do
not. A remote answer moves to the next pending request or closes the sheet through
the existing source subscription. Closing locally never answers or rejects.

## Deadline scope

Preserve the upstream deadline but initially omit the client countdown: the iOS
runtime has no server-aligned clock contract. Never auto-submit local drafts or
pretend the client can disable a provider timeout. Server auto-resolution follows
the same replica close path as a desktop answer. Live Activity remains unchanged.

## Verification

Extend runtime permission tests for all three sources, exact outcome metadata,
invalid/incomplete answers, retries/conflicts and remote resolution. Add an offline
Debug fixture using the production sheet, with multiple questions, multi-select,
free text, upload failure and externally answered states. Drive the fixture through
the UI runner, inspect screenshots and record answer/remote-close behavior. Run
pnpm check, pnpm test and pnpm bundle; build a signed Simulator app for UI checks.
