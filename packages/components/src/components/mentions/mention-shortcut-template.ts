import {
  getShortcutMentionGate,
  getShortcutMentionScopeIssues,
  type PromptShortcutScope,
  type PromptShortcutTarget,
} from '@lody/shared/prompt-shortcuts/model';
import type { MentionCategory, MentionCandidate } from './mention-registry';
import {
  getSkillMentionReferencePath,
  selectSkillMentionCandidates,
  type SkillMentionItem,
} from './mention-skill-source';

/** Freeze the semantic target at selection, not by reparsing a label on save. */
export function shortcutTemplateCategories(input: {
  categories: readonly MentionCategory[];
  scope: PromptShortcutScope;
  skills: readonly SkillMentionItem[];
  allowedDirs: ReadonlySet<string> | null;
  disabledReason: string;
}): MentionCategory[] {
  const { scope } = input;
  const skills = new Map(
    selectSkillMentionCandidates(input.skills, '', input.allowedDirs).map((item) => [
      item.token,
      item,
    ])
  );
  const targetFor = (candidate: MentionCandidate): PromptShortcutTarget | null => {
    if (candidate.kind === 'agent_role')
      return { kind: 'agent_role', agentRoleId: candidate.value };
    if ((candidate.kind === 'file' || candidate.kind === 'dir') && scope.project)
      return {
        kind: 'file',
        project: scope.project,
        path: candidate.value.replace(/\/+$/, ''),
        ...(candidate.kind === 'dir' ? { directory: true } : {}),
      };
    if ((candidate.kind === 'issue' || candidate.kind === 'pr') && scope.project?.kind === 'github')
      return {
        kind: candidate.kind === 'pr' ? 'pull_request' : 'issue',
        repository: scope.project.repository,
        number: Number(candidate.value.replace(/^#/, '')),
      };
    const skill = skills.get(candidate.value);
    if (candidate.kind === 'skill' && skill && scope.providerKey)
      return {
        kind: 'skill',
        source: skill.scope,
        path: getSkillMentionReferencePath(skill),
        compatibleProviders: [scope.providerKey],
        ...(skill.scope === 'project'
          ? { project: scope.project }
          : { machineId: scope.machineId }),
      };
    return null;
  };
  return input.categories
    .filter((category) => category.id !== 'session' && category.id !== 'command')
    .map((category) => {
      const enabled =
        category.id === 'skill'
          ? getShortcutMentionGate('project_skill', scope).enabled ||
            getShortcutMentionGate('global_skill', scope).enabled
          : getShortcutMentionGate(
              category.id === 'pr'
                ? 'pull_request'
                : (category.id as 'file' | 'issue' | 'agent_role'),
              scope
            ).enabled;
      if (!enabled)
        return {
          ...category,
          status: 'disabled',
          message: input.disabledReason,
          activation: undefined,
          getCandidates: () => [],
        };
      return {
        ...category,
        getCandidates: (term, limit) =>
          category.getCandidates(term, limit).flatMap((candidate) => {
            const target = targetFor(candidate);
            if (!target || getShortcutMentionScopeIssues(scope, target).length > 0) return [];
            return [{ ...candidate, value: JSON.stringify(target) }];
          }),
      };
    });
}
