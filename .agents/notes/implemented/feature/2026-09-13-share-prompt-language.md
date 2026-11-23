# Share prompts follow the reader language

Status: implemented
Translation: current

[中文](2026-09-13-share-prompt-language.zh.md)

## Abstract

The reader now has a language switch, so an always-English copied prompt no longer
matches its interface. The requested behavior is to generate the prompt through
the same i18n instance. The static client returns validated access metadata;
the reader owns translated prose. Authorization and expiry remain unchanged.

This supersedes only the English-only prompt decision in the
[static sharing proposal](../../proposed/architecture/2026-09-12-static-session-sharing.md).
Keeping translations in the transport client would duplicate the UI's language
policy, so `createAgentAccess` returns the validated URL and expiry instead.
English and Chinese templates retain the same reference-only, no-forwarding and
expiry instructions. Plaintext interpolation must not HTML-escape the access URL.

Reader tests exercise copying before and after switching language; transport tests
retain pinned authorization and foreign-URL rejection coverage. Hosted end-to-end
issuance was not rerun for this copy-only change. The [Spec](../../../../specs/session-sharing.md)
remains draft; this note does not approve the complete sharing cutover.
