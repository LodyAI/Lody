import * as React from 'react';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import {
  useSkillMentionPromptExpansion,
  type SkillMentionAgent,
} from '@/components/mentions/mention-skill-source';
import {
  expandSessionMentionsInText,
  resolveSessionMentionIds,
  useSessionMentionItems,
  SESSION_MENTION_PREFIX,
} from '@/components/mentions/mention-session-source';

/**
 * The single before-send text transform for every mention type.
 *
 * Most mention types write text an agent can already read (`@path`, `#123`,
 * `/cmd`) and need no transform. The two that do — `$skill` and `@session:` —
 * both keep a short human-readable token in the composer and swap it for the
 * machine-readable form on the way out.
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
  /** Excluded from `@session:` resolution: a session never references itself. */
  currentSessionId?: string | null;
};

export function useMentionPromptExpansion({
  source,
  skillAgent,
  promptValue,
  currentSessionId,
}: MentionPromptExpansionInput): (text: string) => string {
  const expandSkills = useSkillMentionPromptExpansion(source, skillAgent, promptValue);
  // Read here rather than through props: the two send paths should not have to
  // know which data an expansion needs.
  const sessionItems = useSessionMentionItems(currentSessionId);

  return React.useCallback(
    (text: string) => {
      const withSkills = expandSkills(text);
      if (!withSkills.includes(SESSION_MENTION_PREFIX)) return withSkills;
      return expandSessionMentionsInText(withSkills, resolveSessionMentionIds(sessionItems));
    },
    [expandSkills, sessionItems]
  );
}
