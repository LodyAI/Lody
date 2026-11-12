import type { SessionCoordinatorKind } from '@lody/shared';
// The owner edits the Markdown file directly; it is sent verbatim.
import coordinatorSystemPrompt from './coordinator-system-prompt.md?raw';

/** System prompt of a coordinator conversation (`SessionMeta.coordinator` v1). */
export const COORDINATOR_SYSTEM_PROMPT = coordinatorSystemPrompt.trimEnd();

/**
 * The ACP client system prompt for a conversation, or `undefined` for an ordinary
 * one, whose prompts stay unchanged. A marker this build does not understand fails
 * the start instead of running without the coordinator's instructions.
 */
export function resolveSessionSystemPrompt(
  coordinator: SessionCoordinatorKind | undefined
): string | undefined {
  switch (coordinator) {
    case undefined:
    case 'none':
      return undefined;
    case 'v1':
      return COORDINATOR_SYSTEM_PROMPT;
    case 'unsupported':
      throw new Error(
        '[COORDINATOR_UNSUPPORTED] This conversation is a coordinator of a newer version than this machine supports. Update Lody on this machine.'
      );
  }
}
