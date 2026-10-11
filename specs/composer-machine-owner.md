# Composer execution-machine identity

Status: outdated
Translation: current

[中文](composer-machine-owner.zh.md)

The implementation of this proposal was reverted at the user’s request on
2026-10-11. The intent below is retained for history, rather than current behavior;
the info bar no longer persistently displays the machine name and owner.

## Scenario and intent

A team member viewing a Session needs to know whose machine will execute a message
before sending it. Above the composer, show the execution machine owner's avatar,
display name, and machine name. This identity stays visible when other info-bar
items change or take focus, including on narrow screens.

Resolve ownership from the Session's selected machine metadata (`ownerUserId`),
not the Session creator or transferable Session owner. Label the current user's
machine “You”; unresolved ownership reads “Unknown owner” rather than guessing.
Offline presence does not erase identity. Removed/unloaded machine metadata does
not invent a name or reuse the previous Session's identity; existing status UI
continues to explain removal after metadata is ready.

At narrow widths, preserve the owner first and truncate the machine name; the
other info-bar items may take a separate line. This is display-only, with no new
backend, cache, permissions, or machine-switch action.

## Evidence and review

Implementation: `session-chat-interface.tsx` and `session-info-bar.tsx` under
`packages/components/src/components/sessions/`. Synthetic desktop/mobile previews
live in the existing SessionConversationPage Storybook harness. Visual approval
and live team-session verification remain pending.
