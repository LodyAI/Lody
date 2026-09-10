# Conversation context fallback

Status: implemented
Translation: pending

## Abstract

Provider-native forking cannot move every conversation to every destination. The
fork menu offers copying a precise Markdown history prefix independently of native
fork capability. The user manually pastes that context into their chosen Agent,
model or workspace. Automatic pasted-text file conversion and upload feedback were
removed at the user's request; existing paste and submission behavior is preserved.

## Decisions and ownership

[The draft Spec](../../../../specs/conversation-context-copy-and-text-attachments.md)
defines the boundary. Message actions share the copy callback through the existing
conversation action context. Earlier turns, streaming replies and unsupported ACP
providers remain copyable; native fork destinations retain their capability and
completion gates. A pure range helper rejects a missing boundary. Markdown export
preserves prose, marks partial responses and discloses omitted attachment bytes.

Desktop user-message fork buttons follow neighboring copy/pin hover and keyboard
focus behavior, staying visible while their menu is open. Touch actions remain
visible. Assistant fork buttons leave a right margin before metadata; sender names
inherit the timestamp color. Chinese destination hints are kept short.

The earlier editable-text-file experiment was withdrawn because its additional
editing and submission states caused regressions. Its hooks, progress state,
composer changes, tests and locale strings are removed. The original pasted-text
folding, before-send expansion and ordinary attachment transport remain in place.
No new wire fields, upload lifecycle or backend are part of this PR.

## Verification and limits

Synthetic coverage exercises inclusive copy range, unsupported-fork menus,
streaming copy access and native-fork gating. The streaming regression fails on
the earlier completion-gated action bar. Existing paste, mention and submission
suites verify the restored paths. Source comparison against the PR base verifies
that the withdrawn feature no longer changes those paths.

The primary checkout's complete check has been blocked by missing ACP adapter
dependencies. Component typechecking and type-aware lint use the independent
build checkout with the same sources. No live provider round trip was verified.

PR: https://github.com/LodyAI/Lody/pull/558
