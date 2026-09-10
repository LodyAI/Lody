import * as React from 'react';
import {
  applyTextRewrites,
  MESSAGE_TEXT_SPAN_KINDS,
  type MessageTextSpan,
  type MessageTextSpanKind,
  type TextRewrite,
} from '@lody/shared';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import {
  useSkillMentionRewrites,
  type SkillMentionAgent,
} from '@/components/mentions/mention-skill-source';
import { buildSessionMentionRewrites } from '@/components/mentions/mention-session-source';
import {
  buildAgentRoleMentionContext,
  buildAgentRoleMentionRewrites,
  useAgentRoleMentionItems,
} from '@/components/mentions/mention-agent-role-source';
import { buildPastedTextRewrites, type PastedTextDraft } from '@/lib/pasted-text-draft';
import type { Mention as MentionRange } from '@/ui/mention/index';

/**
 * The single before-send transform for every mention type.
 *
 * Two things come out of it, from one pass:
 *
 * - the text the agent receives, with `$skill`, `@session:`, and pasted-text
 *   placeholders swapped for their machine-readable forms
 * - the spans saying which region of that text each mention became, so the
 *   transcript can paint the user's own wording back over it
 *
 * Every contributor describes its edits against the *original composer text*
 * and they are applied together. That is what removes the ordering coupling the
 * send paths used to have — restore-paste, then expand-skills, then
 * expand-sessions, each re-reading a string the previous one had already
 * resized. Now nothing depends on who runs first.
 *
 * Composed in one place on purpose: there are exactly two send paths (chat
 * landing and the session composer), and before this hook each of them wired
 * every expandable type by hand, so adding one meant editing both.
 */
export type MentionPromptExpansionInput = {
  source: MentionProjectSource | undefined;
  skillAgent: SkillMentionAgent | undefined;
  /** Current composer text; used to skip work when no token is present. */
  promptValue: string;
};

export type MentionPromptExpansionArgs = {
  /** Raw composer text, before any expansion. */
  text: string;
  /** Every committed range, from `CombinedMentionTextarea.onMentionRangesChange`. */
  mentions?: readonly MentionRange[];
  pastedTextDrafts?: readonly PastedTextDraft[];
};

export type ExpandedMentionPrompt = {
  text: string;
  spans?: MessageTextSpan[];
};

/**
 * The kinds that have a rewrite builder of their own, and therefore already own
 * their region of the text. Everything else is verbatim.
 *
 * Stated as the short list rather than the long one on purpose. Both directions
 * need one list written by hand; the difference is what a mistake costs. Forget
 * a kind here and it gets two rewrites over one region, which `applyTextRewrites`
 * drops loudly. Forget it in a verbatim allowlist and it simply never gets a
 * transcript chip again — silently, for that kind only. The `satisfies` is the
 * other half: adding a member to `MESSAGE_TEXT_SPAN_KINDS` without classifying
 * it is a type error here rather than a missing chip in production.
 */
const REWRITTEN_SPAN_KINDS = [
  'skill',
  'session',
  'agent_role',
  'pasted_text',
] satisfies MessageTextSpanKind[];

/** Kinds whose composer text is already what the agent should read. */
const VERBATIM_SPAN_KINDS: ReadonlySet<string> = new Set(
  MESSAGE_TEXT_SPAN_KINDS.filter(
    (kind) => !(REWRITTEN_SPAN_KINDS as readonly MessageTextSpanKind[]).includes(kind)
  )
);

/**
 * Identity rewrites for the mentions that need no text change. They contribute
 * no replacement — only a span recording that the region was a mention, which
 * is the only trace left once the range itself is dropped.
 */
export function buildVerbatimMentionRewrites(
  text: string,
  mentions: readonly MentionRange[]
): TextRewrite[] {
  const rewrites: TextRewrite[] = [];
  for (const mention of mentions) {
    const kind = mention.kind;
    if (!kind || !VERBATIM_SPAN_KINDS.has(kind)) continue;
    const label = text.slice(mention.start, mention.end);
    if (!label) continue;
    rewrites.push({
      start: mention.start,
      end: mention.end,
      span: { kind: kind as MessageTextSpanKind, label, target: mention.value },
    });
  }
  return rewrites;
}

export function useMentionPromptExpansion({
  source,
  skillAgent,
  promptValue,
}: MentionPromptExpansionInput): (args: MentionPromptExpansionArgs) => ExpandedMentionPrompt {
  const skillRewrites = useSkillMentionRewrites(source, skillAgent, promptValue);
  const agentRoleContext = React.useMemo(
    () => buildAgentRoleMentionContext({ mentionSource: source }),
    [source]
  );
  // Same owner as the composer menu, by module: both read the shared catalog
  // room, so the list the user picked from is the list this authorizes against.
  const agentRoleItems = useAgentRoleMentionItems(agentRoleContext);

  return React.useCallback(
    ({ text, mentions = [], pastedTextDrafts = [] }: MentionPromptExpansionArgs) => ({
      ...applyTextRewrites(text, [
        ...buildPastedTextRewrites(pastedTextDrafts),
        ...skillRewrites(text),
        ...buildSessionMentionRewrites(text, mentions),
        ...buildAgentRoleMentionRewrites(text, mentions, agentRoleItems),
        ...buildVerbatimMentionRewrites(text, mentions),
      ]),
    }),
    [agentRoleItems, skillRewrites]
  );
}
