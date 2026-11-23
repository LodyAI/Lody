import type { PromptShortcutScope } from '@lody/shared/prompt-shortcuts';
import type { MentionProjectSource } from './mention-project-file-source';
import type { SkillMentionAgent } from './mention-skill-source';

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
