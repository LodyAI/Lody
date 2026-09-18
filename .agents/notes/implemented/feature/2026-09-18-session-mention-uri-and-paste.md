# Paste session URLs into composer mentions as `session://` links

Status: implemented
Translation: current

[中文](2026-09-18-session-mention-uri-and-paste.zh.md)

## Abstract

Pasting a Lody conversation URL into the composer used to insert a raw link, while
session mentions already expanded into a prose MCP instruction that carried only a
session id — agents had to invent how to fetch history, and users had no plain-text
escape hatch when they wanted the URL itself. The composer now converts a lone app
session URL into a session mention unless the paste is Cmd/Ctrl+Shift+V, and the
before-send rewrite emits `[@Title](session://<sessionId>)` instead of the old
instruction sentence. Lody MCP advertises that form in server instructions and
`lody_session_history`, and accepts either a bare id or a `session://` URI. The
binding limit is recognition by app base origin only; foreign hosts and mixed text
still paste as ordinary content.

## Decision and evidence

- The agent-facing form is a markdown link, not an English imperative.
  `buildSessionMentionPrompt` emits `[@Title](session://<id>)`, preferring the
  live session title and falling back to the composer slug. Brackets in the title
  are escaped so the link stays well-formed. The transcript chip still paints the
  composer slug via the span label; copy keeps the expanded `session://` link so
  the paste remains addressable outside Lody.
- Pasting is gated on base URL, not path shape alone.
  [`parseAppSessionUrl`](../../../../packages/components/src/lib/session-app-url.ts)
  accepts only an absolute URL whose origin is the current page or
  `getAppShareOrigin()` (`VITE_SITE_URL` when set), with pathname
  `/{workspace}/sessions/{sessionId}`. Whitespace-bearing clipboard text and
  non-session app paths are left alone. Cmd/Ctrl+Shift+V skips conversion so a
  user can paste a plain link on purpose.
- Insertion lands on the caret (or replaces the selection) through
  `MentionInsertRequest.replaceEnd`, then
  `insertSessionMention(sessionId, { at, replaceEnd })`. An unknown, own, or
  already-mentioned session returns false and the paste falls through to normal
  text — conversion never invents a mention the address list cannot resolve.
- Lody MCP owns the dereference contract. Server `instructions` tell agents to
  call `lody_session_history` for `[@Title](session://…)` links;
  `resolveMcpSessionId` strips a `session://` prefix so either form works. The
  tool description and `sessionId` schema text say the same thing so clients
  that ignore instructions still see the rule on the tool.
- Composer copy must expand the same rewrites as send. `ChatComposer` tracks
  live mention ranges and runs `getExpandedClipboardTextForSelection` on copy,
  so selecting an `@slug` session mention puts `[@Title](session://…)` on the
  clipboard rather than the chip text. Pasted-text expansion shares that helper.

## Verification and limits

- [`session-app-url.test.ts`](../../../../packages/components/tests/session-app-url.test.ts)
  covers allowed origins, search/hash retention, foreign-host rejection, and the
  plain-link shortcut chord.
- [`mention-session-source.test.ts`](../../../../packages/components/tests/mention-session-source.test.ts)
  and [`mention-prompt-spans.test.ts`](../../../../packages/components/tests/mention-prompt-spans.test.ts)
  assert the rewrite emits `session://` links, prefers title when supplied, and
  escapes brackets in labels.
- [`composer-clipboard.test.ts`](../../../../packages/components/tests/composer-clipboard.test.ts)
  covers selection expansion for session rewrites, partial-slug expansion, and
  native-copy fallthrough when nothing expands.
- [`lody-mcp-server.test.ts`](../../../../apps/cli/tests/lody-mcp-server.test.ts)
  asserts `resolveMcpSessionId` accepts bare ids and `session://` URIs and still
  falls back to the current session.
- Paste conversion is wired in the session and landing composers but not driven
  by a rendered paste-event test; recognition of a real browser clipboard and
  packaged Electron paste modifiers was not exercised here.
