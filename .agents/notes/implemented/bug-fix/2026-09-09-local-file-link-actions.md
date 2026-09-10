# Local file links and binary preview actions

Status: implemented
Translation: pending

PR: https://github.com/LodyAI/Lody/pull/555

## Abstract

Assistant file links used filled pills, and successful binary previews omitted
system actions already available on preview errors. The renderer now uses blue
links with matching file-type icons, and binary previews receive the existing
local Open and Reveal callbacks. Binary notices reuse the unavailable-file card
with full-width stacked actions and the shared Copy file path callback, keeping
binary-specific copy while aligning both sidebar states. Local absolute paths are preserved; remote shell
access remains unavailable. The reported native application-not-found message
has not been reproduced, so the absolute-path rejection is a confirmed separate
defect, not proof of that message's cause.

## Decision and evidence

[The draft spec](../../../../specs/local-file-link-actions.md) records the intended
behavior. `useSessionFileActions` owns the More menu and preview callbacks.
Previously `resolveLocalWorkspaceFilePath` rejected every absolute path, even
when local preview had already opened it. It now accepts absolute paths only
when the session machine is local; parent-relative paths are accepted only for local targets; remote traversal remains rejected. IPC
rejections produce an action-specific error instead of unhandled promises.
Electron's existing `revealLocalPath` calls `shell.showItemInFolder`, independently
of default-app launching. No remote preview policy or protocol changes are needed.

## Validation

Regression coverage checks local artifact paths, remote action exclusion and
failed Reveal IPC. Stories render the actual Markdown and binary-preview
components. Final executed check results accompany delivery; native Finder
behavior still requires an actual desktop runtime check.

## Link color refinement

Use Tailwind `text-sky-700 dark:text-sky-400`: Sky 700 reduces chroma relative
to Blue 600 in the light conversation, while Sky 400 stays legible on dark
surfaces. This is a local design choice, not a Tailwind-prescribed link color.
The [Tailwind color guide](https://tailwindcss.com/docs/colors) supplies the
palette and dark-variant pattern. Browser measurements against the rendered
Story backgrounds give approximately 5.86:1 on white and 8.73:1 on #101010
(using canvas sRGB conversion); both exceed the ordinary-text 4.5:1 criterion
in [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
Both rendered themes retain transparent backgrounds, zero borders, and exactly
matching icon/text colors. This follow-up changes only two color classes.

## System-action failure follow-up

The shared path guard reported every unresolved path as a generic open failure
without calling IPC or logging. The earlier absolute-path fix still rejected
local `../artifacts/Lody.dmg`, although local preview resolves that path against
the workspace. The local-only guard now accepts it. Tests exercise both Finder
and editor dispatch; remote shell actions remain absent. The running 0.89.4 test app was verified from its process executable and bundled
renderer in app.asar. Replaying that bundled resolver rejects both synthetic
absolute and parent-relative DMG paths, while accepting workspace-relative paths.
The packaged guard returns the generic toast before either native action and has
no console diagnostic. The exact user file path is still unavailable; the current
workspace patch is not yet installed in that running app.

All three actions now report missing bridges, rejected IPC and returned errors
through one handler. Local console details preserve action, requested/resolved
paths, workspace/session/machine identity, system result and exception stack.
The toast provides reason-specific guidance and a user-initiated Copy error
details action. Electron preserves permission/IO errors instead of mapping all
access failures to not-found.

VS Code's protocol fallback also appended a slash to files, treating them as
directories. File actions now specify file identity while existing workspace
launchers keep directory URLs, matching the
[VS Code URL contract](https://code.visualstudio.com/docs/configure/command-line#_opening-vs-code-with-urls).

Validation for the follow-up: 63 targeted component tests and six native core
tests passed; component and Electron main typechecks passed. The full repository typecheck and lint passed. Full test:ci passed after retrying
outside the sandbox (the initial attempt could not listen on loopback): all 445
component test files, 257 CLI test files (one skipped), and 105 Electron tests
passed. i18n, documentation, Code Collab, platform and public-boundary checks
also passed. The running packaged app has not been replaced.
