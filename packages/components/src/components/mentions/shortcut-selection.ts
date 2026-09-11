import {
  PromptShortcutError,
  resolveShortcutAvailability,
  type PromptShortcutIndexEntry,
  type PromptShortcutRuntime,
  type ShortcutAvailability,
} from '@lody/shared/prompt-shortcuts';
import type { MentionPrepare, PreparedMention } from '@/ui/mention/index';
import {
  unverifiedShortcutDependency,
  type ShortcutDependencyResolver,
  type ShortcutMentionContext,
} from './mention-prompt-shortcut-source';

export type ShortcutSelectionRuntime = Pick<
  PromptShortcutRuntime,
  'read' | 'getSnapshot' | 'workspaceId' | 'userId'
>;
export class ShortcutSelectionUnavailable extends Error {
  constructor(readonly availability: ShortcutAvailability) {
    super(availability.kind);
  }
}

/** A selection reads precisely one version, then checks the live index again. */
export async function prepareShortcutSelection(input: {
  runtime: ShortcutSelectionRuntime;
  entry: PromptShortcutIndexEntry;
  context: ShortcutMentionContext;
  request: Parameters<MentionPrepare>[0];
  isCurrent: () => boolean;
  resolveDependency?: ShortcutDependencyResolver;
}): Promise<PreparedMention | null> {
  const { runtime, entry, request, context } = input;
  const current = () => !request.signal.aborted && input.isCurrent();
  const checkIndex = () => {
    if (runtime.workspaceId !== context.workspaceId || runtime.userId !== context.userId)
      throw new PromptShortcutError('forbidden', 'Selection identity changed');
    const latest = runtime.getSnapshot().entries.find((item) => item.id === entry.id);
    if (!latest) throw new PromptShortcutError('not_found', 'Shortcut is no longer listed');
    if (latest.revision !== entry.revision || latest.bodyDocId !== entry.bodyDocId)
      throw new PromptShortcutError('revision_pending', 'Shortcut changed during selection');
  };
  if (!current()) return null;
  checkIndex();
  const snapshot = await runtime.read(entry);
  if (!current()) return null;
  checkIndex();
  if (
    snapshot.id !== entry.id ||
    snapshot.revision !== entry.revision ||
    snapshot.workspaceId !== entry.workspaceId ||
    snapshot.ownerUserId !== entry.ownerUserId ||
    snapshot.visibility !== entry.visibility
  )
    throw new PromptShortcutError('revision_pending', 'Index and body do not agree');
  const availability = resolveShortcutAvailability({
    shortcut: snapshot,
    dependencies: snapshot.mentions.map((mention) => mention.target),
    context,
    canRead: true,
    resolveDependency: input.resolveDependency ?? unverifiedShortcutDependency,
  });
  if (availability.kind !== 'available') throw new ShortcutSelectionUnavailable(availability);
  return {
    text: snapshot.prompt,
    mentions: snapshot.mentions.map(({ start, end, label, target }) => ({
      start,
      end,
      kind:
        target.kind === 'pull_request'
          ? 'pr'
          : target.kind === 'file' && target.directory
            ? 'dir'
            : target.kind,
      value:
        target.kind === 'agent_role'
          ? target.agentRoleId
          : target.kind === 'file'
            ? target.path
            : target.kind === 'skill'
              ? label.replace(/^\$/, '')
              : `#${target.number}`,
    })),
  };
}
