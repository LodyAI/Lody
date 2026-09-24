import { useMemo } from 'react';
import type { MessageTextSpan, TextRewrite } from '@lody/shared';

/**
 * `@/components/mentions/mention-expansion` resolves Agent Role and session
 * mentions through `useVisibleMachineMetas`, which requires the app's
 * `AuthenticatedConvexProvider`; rendering the real hook inside `ChatComposer`
 * throws on the public site. The preview never sends a prompt, so expansion is
 * the identity here.
 */
export type MentionPromptExpansionInput = {
  source: unknown;
  skillAgent: unknown;
  promptValue: string;
};

export type MentionPromptExpansionArgs = {
  text: string;
  mentions?: readonly unknown[];
  pastedTextDrafts?: readonly unknown[];
};

export type ExpandedMentionPrompt = {
  text: string;
  spans?: MessageTextSpan[];
};

export type MentionPromptExpansion = {
  expand: (args: MentionPromptExpansionArgs) => ExpandedMentionPrompt;
  getRewrites: (args: MentionPromptExpansionArgs) => TextRewrite[];
};

export function useMentionPromptExpansion(
  _input: MentionPromptExpansionInput & { currentSessionId?: string | null }
): MentionPromptExpansion {
  return useMemo(
    () => ({
      expand: ({ text }) => ({ text }),
      getRewrites: () => [],
    }),
    []
  );
}
