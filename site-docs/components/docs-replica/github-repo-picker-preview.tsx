import * as stylex from '@stylexjs/stylex';
import {
  ReplicaBranchWorktreePill,
  ReplicaPermissionModeTrigger,
  ReplicaProjectSelectorTrigger,
  ReplicaRunConfigTrigger,
} from '../landing-replica/composer-controls';
import type { ReplicaLocale } from '../landing-replica/types';
const previewStyles = stylex.create({
  section: {
    'margin-block': 'calc(var(--spacing) * 6)',
  },
  text: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
    padding: 'calc(var(--spacing) * 4)',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
    '--composer': 'var(--muted)',
    '@media (width >= 40rem)': {
      padding: 'calc(var(--spacing) * 6)',
    },
  },
  frame: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': 'var(--container-2xl)',
  },
  row: {
    display: 'flex',
    width: '100%',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'var(--spacing)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  stack: {
    'margin-top': 'var(--spacing)',
    display: 'flex',
    'flex-direction': 'column',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--foreground)) 10%, transparent)',
    'background-color': 'hsl(var(--composer))',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    ':where(.dark, .dark *)': {
      'border-color': 'color-mix(in oklab, hsl(var(--input-border)) 70%, transparent)',
      'background-color': 'color-mix(in oklab, hsl(var(--input)) 90%, transparent)',
    },
  },
  text2: {
    'min-height': '88px',
    'padding-inline': 'var(--spacing)',
    'padding-top': 'var(--spacing)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'color-mix(in oklab, hsl(var(--input-placeholder)) 40%, transparent)',
  },
  row2: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'padding-top': 'calc(var(--spacing) * 0.5)',
  },
  text3: {
    'margin-top': 'calc(var(--spacing) * 2)',
    'text-align': 'center',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
});

/* Display-only docs preview of the home composer's repository and branch
   pickers. It reuses the landing replica's trigger markup with synthetic data,
   so the GitHub guide does not ship a stale screenshot of the old home page. */

type Copy = {
  branch: string;
  caption: string;
  permission: string;
  placeholder: string;
  repo: string;
};

const COPY: Record<ReplicaLocale, Copy> = {
  en: {
    branch: 'main',
    caption:
      'Mock composer. Choose a workspace repository in the top-left selector, then pick its branch.',
    permission: 'Agent (full access)',
    placeholder: 'Tell the agent what you need.',
    repo: 'loro-dev/lody',
  },
  zh: {
    branch: 'main',
    caption: '模拟输入框。在左上角选择工作区里的仓库，再选择对应的分支。',
    permission: 'Agent (full access)',
    placeholder: '告诉 Agent 你需要什么。',
    repo: 'loro-dev/lody',
  },
};

/** The repo/branch row above the home composer, with synthetic repository data. */
export function GithubRepoPickerPreview({ locale = 'en' }: { locale?: ReplicaLocale }) {
  const copy = COPY[locale];
  return (
    <div {...stylex.props(previewStyles.section)}>
      <div
        aria-hidden="true"
        className={['lody-app-preview', stylex.props(previewStyles.text).className].join(' ')}
      >
        <div {...stylex.props(previewStyles.frame)}>
          <div {...stylex.props(previewStyles.row)}>
            <ReplicaProjectSelectorTrigger label={copy.repo} kind="github" locale={locale} />
            <ReplicaBranchWorktreePill
              branch={copy.branch}
              worktree={false}
              showWorktree={false}
              locale={locale}
            />
          </div>
          <div {...stylex.props(previewStyles.stack)}>
            <div {...stylex.props(previewStyles.text2)}>{copy.placeholder}</div>
            <div {...stylex.props(previewStyles.row2)}>
              <ReplicaRunConfigTrigger agent="codex" modelLabel="5.3-codex" thinkLabel="xhigh" />
              <ReplicaPermissionModeTrigger label={copy.permission} modeId="agent-full-access" />
            </div>
          </div>
        </div>
      </div>
      <div {...stylex.props(previewStyles.text3)}>{copy.caption}</div>
    </div>
  );
}
