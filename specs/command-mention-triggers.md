# Command mention triggers

Status: draft
Translation: current

[中文](command-mention-triggers.zh.md)

Typing `/` or the Chinese enumeration comma `、` opens the same command menu.
Both prefixes support filtering by command name. Selecting a command replaces
its trigger and query with the canonical `/command` token.

Commands are offered only when the entire composer contains the prefix and a
whitespace-free query. Ordinary prose containing `、` must not offer commands.
Existing command availability gates apply to both prefixes. Prompt Shortcuts,
when enabled, retain their existing inline behavior through either prefix.
Typing the alias alone does not rewrite text or execute a command; selection
uses the existing mention insertion path.

## Evidence

- [Composer](../packages/components/src/components/mentions/combined-mention-textarea.tsx)
- [Menu registry](../packages/components/src/components/mentions/mention-registry.ts)
- [Behavioral tests](../packages/components/tests/combined-mention-textarea-activation.test.tsx)
