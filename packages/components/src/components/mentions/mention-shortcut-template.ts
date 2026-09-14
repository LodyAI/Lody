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

/** The scope axes a disabled mention category is still waiting for. */
export type ShortcutScopeAxis = keyof PromptShortcutScope;

/** Freeze the semantic target at selection, not by reparsing a label on save. */
export function shortcutTemplateCategories(input: {
  categories: readonly MentionCategory[];
  scope: PromptShortcutScope;
  skills: readonly SkillMentionItem[];
  allowedDirs: ReadonlySet<string> | null;
  disabledReason: (missing: readonly ShortcutScopeAxis[]) => string;
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
    .filter((category) => !['session', 'command', 'prompt_shortcut'].includes(category.id))
    .map((category) => {
      // Skills come from two sources; either one being satisfiable enables the
      // category, so the missing axes are the ones the closer source still needs.
      const gates =
        category.id === 'skill'
          ? [
              getShortcutMentionGate('project_skill', scope),
              getShortcutMentionGate('global_skill', scope),
            ]
          : [
              getShortcutMentionGate(
                category.id === 'pr'
                  ? 'pull_request'
                  : (category.id as 'file' | 'issue' | 'agent_role'),
                scope
              ),
            ];
      const enabled = gates.some((gate) => gate.enabled);
      if (!enabled) {
        const missing = gates.reduce<ShortcutScopeAxis[]>(
          (fewest, gate) => (gate.missing.length < fewest.length ? [...gate.missing] : fewest),
          [...(gates[0]?.missing ?? [])]
        );
        return {
          ...category,
          status: 'disabled',
          // Name the axes THIS kind of reference needs. One sentence repeated
          // under every disabled entry says only "something is missing".
          message: input.disabledReason(missing),
          activation: undefined,
          getCandidates: () => [],
        };
      }
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
