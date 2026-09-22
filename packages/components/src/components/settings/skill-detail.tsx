import { useTranslation } from 'react-i18next';
import { User } from 'lucide-react';
import type { ProjectSkill, ProjectSkillScope } from '@lody/shared';
import { Dialog } from '@/ui/dialog';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { ErrorBoundary } from '@/components/error-boundary';
import { SkillMarkdownFallback } from '@/components/settings/skill-markdown';
import {
  SkillScopeBadge,
  SkillSymlinkBadge,
  SkillVersionBadge,
} from '@/components/settings/skill-badges';
import { cn } from '@/lib/utils';

/**
 * Shared skill detail body: badges + metadata + the rendered SKILL.md markdown
 * (`skill.content`, frontmatter already stripped by the scanner). The skill
 * name is the surrounding title (Dialog.Title on desktop, the sheet header on
 * mobile), so it is intentionally not repeated here.
 */
export function SkillDetailContent({
  skill,
  scope,
  className,
}: {
  skill: ProjectSkill;
  scope?: ProjectSkillScope;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {scope ? <SkillScopeBadge scope={scope} /> : null}
          {skill.version ? <SkillVersionBadge version={skill.version} /> : null}
          {skill.isSymlink ? <SkillSymlinkBadge symlinkTarget={skill.symlinkTarget} /> : null}
        </div>
        {skill.description ? (
          <p className="mt-2 text-sm text-muted-foreground">{skill.description}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {skill.author ? (
            <span className="inline-flex items-center gap-1">
              <User className="h-3 w-3" />
              {skill.author}
            </span>
          ) : null}
          <span className="min-w-0 truncate font-mono">{skill.relativePath}</span>
        </div>
      </div>

      <div className="scrollbar-pro mt-3 min-h-0 flex-1 overflow-y-auto border-t border-border/60 pt-3">
        {skill.content ? (
          /* Primary: the app's full Markdown renderer (Streamdown). It lazy-
             loads a Shiki code highlighter; if that dynamic import fails (e.g. a
             stale Vite dev optimize-deps chunk) the boundary falls back to a
             dependency-free Markdown renderer so the content still renders as
             Markdown — never raw text. */
          <ErrorBoundary
            name="SkillMarkdown"
            variant="inline"
            resetKeys={[skill.relativePath]}
            fallback={<SkillMarkdownFallback content={skill.content} />}
          >
            <MarkdownRenderer text={skill.content} size="sm" />
          </ErrorBoundary>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(
              'workspace.projects.skills.detailNoContent',
              'This skill has no additional content.'
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/** Desktop: a large dialog rendering the skill's SKILL.md markdown. */
export function SkillDetailDialog({
  skill,
  scope,
  open,
  onOpenChange,
}: {
  skill: ProjectSkill | null;
  scope?: ProjectSkillScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-0 overflow-hidden">
        <Dialog.Header className="shrink-0 pb-3 pr-8 text-left">
          <Dialog.Title className="truncate">{skill?.name}</Dialog.Title>
        </Dialog.Header>
        {skill ? (
          <SkillDetailContent skill={skill} scope={scope} className="min-h-0 flex-1" />
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}
