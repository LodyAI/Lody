import { text as uiText } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';
import type { MouseEvent } from 'react';
import { User } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
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
import { withClassName } from '@/lib/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', minHeight: 0 },
  head: { flexShrink: 0 },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[1.5] },
  description: {
    margin: 0,
    marginTop: space[2],
    fontSize: uiText.footnoteSize,
    color: colors.secondaryLabel,
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[3],
    rowGap: space[1],
    marginTop: space[2],
    fontSize: uiText.footnoteSize,
    color: colors.secondaryLabel,
  },
  author: { display: 'inline-flex', alignItems: 'center', gap: space[1] },
  authorIcon: { width: '12px', height: '12px', flexShrink: 0, color: colors.tertiaryLabel },
  path: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },
  /** The body is set apart from the head by space, not a rule under it. */
  body: { flexGrow: 1, minHeight: 0, overflowY: 'auto', marginTop: space[4] },
  empty: { margin: 0, fontSize: uiText.footnoteSize, color: colors.secondaryLabel },
  title: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  fill: { flexGrow: 1, minHeight: 0 },
});

/** The panel reads a SKILL.md, so it keeps a reading width rather than a form's. */
const SKILL_DIALOG_WIDTH = '768px';

function navigateSkillFragment(event: MouseEvent<HTMLDivElement>) {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest('a[href^="#"]');
  if (!link || !event.currentTarget.contains(link)) return;
  // Fragments belong to this detail, never the router or another mounted document.
  event.preventDefault();
  let id: string;
  try {
    id = decodeURIComponent(link.getAttribute('href')!.slice(1));
  } catch {
    return;
  }
  const heading = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')
  ).find((element) => element.id === id);
  if (!heading) return;
  heading.scrollIntoView({ block: 'start' });
  heading.focus({ preventScroll: true });
}

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
    <div {...withClassName(stylex.props(styles.root), className)}>
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(styles.badges)}>
          {scope ? <SkillScopeBadge scope={scope} /> : null}
          {skill.version ? <SkillVersionBadge version={skill.version} /> : null}
          {skill.isSymlink ? <SkillSymlinkBadge symlinkTarget={skill.symlinkTarget} /> : null}
        </div>
        {skill.description ? (
          <p {...stylex.props(styles.description)}>{skill.description}</p>
        ) : null}
        <div {...stylex.props(styles.meta)}>
          {skill.author ? (
            <span {...stylex.props(styles.author)}>
              <User {...stylex.props(styles.authorIcon)} />
              {skill.author}
            </span>
          ) : null}
          <span {...stylex.props(styles.path)}>{skill.relativePath}</span>
        </div>
      </div>

      <div
        onClickCapture={navigateSkillFragment}
        {...withClassName(stylex.props(styles.body), 'scrollbar-pro')}
      >
        {skill.content ? (
          /* Primary: the app's full Markdown renderer (Streamdown). It lazy-
             loads a Shiki code highlighter; if that dynamic import fails (e.g. a
             stale Vite dev optimize-deps chunk) the boundary falls back to a
             small Markdown renderer so the content still renders as
             Markdown — never raw text. */
          <ErrorBoundary
            name="SkillMarkdown"
            variant="inline"
            resetKeys={[skill.relativePath]}
            fallback={<SkillMarkdownFallback content={skill.content} />}
          >
            <MarkdownRenderer text={skill.content} size="sm" headingAnchors />
          </ErrorBoundary>
        ) : (
          <p {...stylex.props(styles.empty)}>
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
      <Dialog.Content width={SKILL_DIALOG_WIDTH}>
        <Dialog.Header>
          <Dialog.Title {...stylex.props(styles.title)}>{skill?.name}</Dialog.Title>
        </Dialog.Header>
        {skill ? (
          <SkillDetailContent
            skill={skill}
            scope={scope}
            className={stylex.props(styles.fill).className}
          />
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}
