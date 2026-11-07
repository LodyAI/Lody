export type { PromptShortcut } from '../protocol/prompt-shortcuts/model.ts';
export type { PromptShortcutIndexEntry } from '../protocol/prompt-shortcuts/catalog.ts';
import type { PromptShortcut } from '../protocol/prompt-shortcuts/model.ts';
import type { PromptShortcutIndexEntry } from '../protocol/prompt-shortcuts/catalog.ts';
export type ShortcutRequest = {
  workspaceId: string;
} & (
  | { action: 'list' }
  | { action: 'read'; entry: PromptShortcutIndexEntry }
  | {
      action: 'save';
      entry: PromptShortcutIndexEntry | null;
      value: PromptShortcut;
      bodyDocId: string;
    }
);
// Structured templates remain intact and read-only until their dependencies can
// be verified in both composer hosts. Never flatten their ranges into plain text.
export function simpleShortcut(value: {
  scope: object;
  mentions?: unknown[];
  dependencySummary?: unknown[];
}) {
  return (
    !Object.keys(value.scope).length &&
    !(value.mentions ?? value.dependencySummary ?? []).length
  );
}
