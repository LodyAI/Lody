import {
  resolveShortcutAvailability,
  type ShortcutAvailability,
} from '@lody/shared/prompt-shortcuts';
import {
  unverifiedShortcutDependency,
  type ShortcutMentionContext,
  type ShortcutDependencyResolver,
} from './mention-prompt-shortcut-source';
import type { PromptShortcutScope, ShortcutInvocation } from '@lody/shared/prompt-shortcuts';
import type { Mention } from '@/ui/mention/index';
import type { MentionProjectSource } from './mention-project-file-source';
import type { SkillMentionAgent } from './mention-skill-source';

/** Values and the immutable selection snapshot travel with the range through edits. */
export type ShortcutMention = Mention & { kind: 'prompt_shortcut'; data: ShortcutInvocation };
export function isShortcutMention(mention: Mention): mention is ShortcutMention {
  return mention.kind === 'prompt_shortcut' && !!mention.data;
}

/** Ranges the Shortcut draft owns, as opposed to ordinary composer mentions. */
export function isShortcutDraftRange(mention: Mention): boolean {
  return isShortcutMention(mention);
}

export function shortcutComposerScope(
  source?: MentionProjectSource,
  agent?: SkillMentionAgent
): PromptShortcutScope {
  const local =
    source?.kind === 'local'
      ? source
      : source?.kind === 'provider'
        ? source.localProject
        : undefined;
  const repository = source?.kind === 'github' ? source.repoFullName : source?.githubRepoFullName;
  return {
    ...(local
      ? {
          project: { kind: 'local' as const, id: local.localProjectId, machineId: local.machineId },
        }
      : repository
        ? { project: { kind: 'github' as const, repository } }
        : {}),
    ...(agent?.machineId ? { machineId: agent.machineId } : {}),
    ...(agent ? { providerKey: `${agent.cliType}:${agent.agentType}` } : {}),
  };
}

export function shortcutInvocationAvailability(
  invocation: ShortcutInvocation,
  context: ShortcutMentionContext | null,
  resolveDependency: ShortcutDependencyResolver = unverifiedShortcutDependency
): ShortcutAvailability {
  if (!context) return { kind: 'unknown', reason: 'dependencies_loading' };
  return resolveShortcutAvailability({
    shortcut: invocation.snapshot,
    dependencies: invocation.snapshot.mentions.map((mention) => mention.target),
    context,
    canRead: true,
    resolveDependency,
  });
}
