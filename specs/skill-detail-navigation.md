# Skill detail navigation

Status: draft
Translation: current

[中文版](skill-detail-navigation.zh.md)

In Settings → Projects → Skills, opening a skill's details presents its existing
Markdown as a read-only document. A fragment-only link such as
`#handle-rebase-conflicts-agent-workflow` navigates within that detail, even when
the host page is a different route.

Headings use GitHub-style slugs of their rendered text. Chinese text is retained;
inline formatting contributes its text; repeated headings receive `-1`, `-2`,
and later suffixes in document order, including nested headings. Percent-encoded
fragments resolve to the same headings. Navigation scrolls to and focuses the
matching heading in the current detail without changing the host URL or opening
a tab. Missing or malformed fragments leave the detail open without navigation.

External links keep the existing external-link behavior. Closing the desktop
detail preserves the Skills search query and returns focus to its opener. The
skill source is never rewritten. The fallback renderer supports anchors for the
headings it can render; its existing Markdown subset is not a full parser.

## Evidence

- [Detail surface](../packages/components/src/components/settings/skill-detail.tsx)
- [Markdown renderer](../packages/components/src/components/ai-gui/markdown-renderer.tsx)
- [Fallback](../packages/components/src/components/settings/skill-markdown.tsx)
- [Regression suite](../packages/components/tests/skill-markdown.test.tsx)
- [Decision and verification limits](../.agents/notes/implemented/bug-fix/2026-10-01-skill-detail-anchors.md)
