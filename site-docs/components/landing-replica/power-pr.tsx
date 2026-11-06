import * as stylex from '@stylexjs/stylex';
/**
 * Display-only replica of the app's embedded `PrTabView` (landing "power"
 * section): slim header with the PR badge + green Squash split button, the PR
 * description, the collapsed "All checks passed" row, the conversation cards and
 * the decorative comment composer. The frame is inert; nothing here is wired.
 */

import { CheckCircle2, ChevronDown, GitMerge, GitPullRequest } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
const prBlockSpacing = stylex.create({
  space1: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': '0',
      'margin-block-end': 'calc(var(--spacing) * 1)',
    },
  },
  space1_5: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': '0',
      'margin-block-end': 'calc(var(--spacing) * 1.5)',
    },
  },
});

const prSpacing = stylex.create({
  markdown: { maxWidth: 'none', color: 'hsl(var(--foreground))', lineHeight: '1.75' },
  body: {
    marginInline: 'auto',
    width: '100%',
    maxWidth: 'var(--container-3xl)',
    paddingInline: 'calc(var(--spacing) * 5)',
    paddingTop: 'calc(var(--spacing) * 5)',
    paddingBottom: 'calc(var(--spacing) * 5)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 3.5)',
    },
  },
  section: {
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 2)',
    },
  },
  sectionLoose: {
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 3)',
    },
  },
  list: {
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 2.5)',
    },
  },
});
const powerPrComposition = stylex.create({
  part1: {
    'border-radius': 'var(--radius-sm)',
    'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 8%, transparent)',
    'padding-inline': 'var(--spacing)',
    'padding-block': '1px',
    'font-family': 'var(--font-mono)',
    'font-size': '0.85em',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000,  0 0 0 calc(0px + 0px) currentcolor, 0 0 #0000',
    ':is(*):where(.dark, .dark *)': {
      'background-color':
        'color-mix(in oklab, hsl(var(--foreground)) 14.000000000000002%, transparent)',
    },
  },
  part2: {
    'max-width': 'none',
    'line-height': '1.75',
    color: 'hsl(var(--foreground))',
  },
  part3: {
    'margin-top': 'calc(var(--spacing) * 5)',
    'margin-bottom': 'calc(var(--spacing) * 2)',
    'font-size': '16px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-tight)',
    ':is(*):first-child': {
      'margin-top': '0px',
    },
  },
  part4: {
    'margin-top': '0px',
    'margin-bottom': 'calc(var(--spacing) * 3)',
    ':is(*):last-child': {
      'margin-bottom': '0px',
    },
  },
  part5: {
    'margin-block': 'calc(var(--spacing) * 2)',
    'list-style-type': 'none',
    'padding-left': '0px',
  },
  part6: {
    position: 'relative',
    'margin-block': '0px',
    'padding-block': '0px',
    'padding-left': 'calc(var(--spacing) * 6)',
    ':is(*)::before': {
      content: "''",
      position: 'absolute',
      top: '0.75em',
      left: '10px',
      width: 'var(--spacing)',
      height: 'var(--spacing)',
      translate: '0 calc(calc(1 / 2 * 100%) * -1)',
      'border-radius': 'calc(infinity * 1px)',
      'background-color': 'currentcolor',
    },
    ':is(*):not(:first-child)': {
      'margin-top': 'var(--spacing)',
    },
  },
  part7: {
    position: 'relative',
    display: 'flex',
    'flex-shrink': '0',
    overflow: 'hidden',
    'border-radius': 'calc(infinity * 1px)',
  },
  part8: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
  part9: {
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
  },
  part10: {
    display: 'flex',
    width: '100%',
    height: '100%',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--muted))',
  },
  part11: {
    'font-size': '8px',
  },
  part12: {
    'font-size': '0.8em',
  },
  part13: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 30%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  part14: {
    'flex-wrap': 'wrap',
  },
});

const powerPrStylesNative = stylex.create({
  row: {
    display: 'inline-flex',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-md)',
    'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 6%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-block': 'calc(var(--spacing) * 0.5)',
    'font-size': '11px',
    'font-weight': 'var(--font-weight-normal)',
    color: 'hsl(var(--github-open))',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
});

const powerPrStyles = stylex.create({
  surface: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
  },
  label: {
    'font-size': '0.9em',
    'line-height': '1',
    'font-weight': 'var(--font-weight-medium)',
  },
  label2: {
    'font-size': '0.8em',
    'line-height': '1',
    color: 'hsl(var(--muted-foreground))',
  },
  section: {
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  row: {
    display: 'inline-flex',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'calc(infinity * 1px)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--status-success)) 40%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--status-success)) 10%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-block': 'calc(var(--spacing) * 0.5)',
    'font-size': '0.75em',
    'font-weight': 'var(--font-weight-medium)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--status-success))',
    'text-transform': 'uppercase',
  },
  glyph: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
  },
  stack: {
    'container-type': 'inline-size',
    'container-name': 'pr-tab',
    display: 'flex',
    height: '100%',
    'min-height': '0px',
    'flex-direction': 'column',
    'background-color': 'hsl(var(--background))',
  },
  row2: {
    display: 'flex',
    height: 'calc(var(--spacing) * 12)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 2)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 5)',
  },
  row3: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  label3: {
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': '0.9em',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground))',
  },
  section2: {
    'flex-shrink': '0',
  },
  row4: {
    display: 'flex',
    'align-items': 'stretch',
    overflow: 'hidden',
    'border-radius': 'var(--radius-md)',
  },
  frame: {
    position: 'relative',
    'min-height': '0px',
    flex: '1',
    overflow: 'hidden',
  },
  frame2: {
    height: '100%',
    width: '100%',
    'scrollbar-width': 'none',
    'overflow-y': 'auto',
    ':is(*)::-webkit-scrollbar': {
      display: 'none',
    },
  },
  caption: {
    'font-size': '1em',
    'line-height': 'var(--leading-snug)',
    'font-weight': 'var(--font-weight-semibold)',
    'text-wrap': 'pretty',
  },
  label4: {
    'margin-left': 'calc(var(--spacing) * 2)',
    'font-size': '0.9em',
    'font-weight': 'var(--font-weight-normal)',
    color: 'hsl(var(--muted-foreground))',
  },
  stack2: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'var(--spacing)',
    'font-size': '0.8em',
    color: 'hsl(var(--muted-foreground))',
    '@container pr-tab (width >= 420px)': {
      'flex-direction': 'row',
      'flex-wrap': 'wrap',
      'align-items': 'center',
      'column-gap': 'calc(var(--spacing) * 2)',
    },
  },
  row5: {
    display: 'inline-flex',
    'min-width': '0px',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    'column-gap': 'calc(var(--spacing) * 1.5)',
    'row-gap': 'calc(var(--spacing) * 0.5)',
  },
  label5: {
    'font-weight': 'var(--font-weight-normal)',
    color: 'hsl(var(--foreground))',
  },
  row6: {
    display: 'inline-flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-variant-numeric': '   tabular-nums ',
  },
  label6: {
    color: 'hsl(var(--status-success))',
  },
  label7: {
    color: 'hsl(var(--status-danger))',
  },
  caption2: {
    'margin-top': 'var(--spacing)',
    'font-size': '0.9em',
    'line-height': 'var(--leading-relaxed)',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
  },
  surface2: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
  },
  row7: {
    display: 'flex',
    width: '100%',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 2)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'text-align': 'left',
  },
  row8: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'font-size': '0.9em',
    'font-weight': 'var(--font-weight-medium)',
  },
  glyph2: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    color: 'hsl(var(--status-success))',
  },
  label8: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  row9: {
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-size': '0.8em',
    color: 'hsl(var(--muted-foreground))',
    'font-variant-numeric': '   tabular-nums ',
  },
  glyph3: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  row10: {
    display: 'flex',
    'min-height': '72px',
    width: '100%',
    resize: 'none',
    overflow: 'hidden',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--input-border))',
    'background-color': 'hsl(var(--background))',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--input-foreground))',
    ':is(*)::placeholder': {
      color: 'hsl(var(--input-placeholder))',
    },
  },
  row11: {
    display: 'flex',
    'justify-content': 'flex-end',
  },
});

const buttonStyles = stylex.create({
  action: {
    height: 'calc(var(--spacing) * 7)',
    gap: 'calc(var(--spacing) * 1.5)',
    paddingInline: 'calc(var(--spacing) * 2.5)',
    fontSize: '.9em',
  },
  green: {
    backgroundColor: {
      default: 'hsl(var(--status-success))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab,hsl(var(--status-success)) 90%,transparent)',
      },
    },
    color: { default: 'var(--color-white)', ':where(.dark, .dark *)': 'hsl(var(--background))' },
  },
  merge: { borderTopRightRadius: 0, borderBottomRightRadius: 0, borderColor: 'transparent' },
  split: {
    height: 'calc(var(--spacing) * 7)',
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    paddingInline: 'calc(var(--spacing) * 1.5)',
    borderLeftWidth: 1,
    borderLeftStyle: 'solid',
    borderLeftColor: {
      default: 'color-mix(in oklab,var(--color-white) 25%,transparent)',
      ':where(.dark, .dark *)': 'color-mix(in oklab,var(--color-black) 25%,transparent)',
    },
  },
  compactGap: { gap: 'calc(var(--spacing) * 1)' },
});

export type PowerPrLabels = {
  mergeShortSquash: string;
  moreActions: string;
  opened: (when: string) => string;
  commits: (count: number) => string;
  files: (count: number) => string;
  checksPassed: string;
  checksCount: (count: number) => string;
  commented: string;
  reviewApproved: string;
  composerPlaceholder: string;
  composerSubmit: string;
};

/** Inline run of a pre-structured Markdown line: plain text or inline code. */
export type PowerPrInline = string | { code: string };

export type PowerPrBodyBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; runs: readonly PowerPrInline[] }
  | { kind: 'list'; items: readonly (readonly PowerPrInline[])[] };

export type PowerPrConversationItem =
  | { kind: 'comment'; id: string; author: string; createdAt: string; body: string }
  | { kind: 'review'; id: string; author: string; submittedAt: string; body: string };

export type PowerPrData = {
  repoFullName: string;
  number: number;
  title: string;
  author: string;
  /** ISO timestamps; rendered as a fixed UTC date so SSR and client agree. */
  createdAt: string;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  body: readonly PowerPrBodyBlock[];
  checksTotal: number;
  conversation: readonly PowerPrConversationItem[];
};

export type PowerPrViewProps = {
  data: PowerPrData;
  labels: PowerPrLabels;
  /** BCP 47 locale for the comment dates. */
  intlLocale: string;
};

/** Same classes MarkdownRenderer applies (size "sm" = 14px body, 16px h2). */
const MD_ROOT = ['markdown-renderer', stylex.props(prSpacing.markdown).className].join(' ');
const MD_H2 = powerPrComposition.part3;
const MD_P = powerPrComposition.part4;
const MD_UL = powerPrComposition.part5;
const MD_LI = powerPrComposition.part6;
const MD_CODE = powerPrComposition.part1;

function formatDate(iso: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

function Inline({ runs }: { runs: readonly PowerPrInline[] }) {
  return (
    <>
      {runs.map((run, index) =>
        typeof run === 'string' ? (
          <span key={index}>{run}</span>
        ) : (
          <code key={index} {...stylex.props(MD_CODE)}>
            {run.code}
          </code>
        )
      )}
    </>
  );
}

function Markdown({ blocks }: { blocks: readonly PowerPrBodyBlock[] }) {
  return (
    <div className={MD_ROOT} style={{ fontSize: '14px' }}>
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <h2 key={index} {...stylex.props(MD_H2)}>
              {block.text}
            </h2>
          );
        }
        if (block.kind === 'paragraph') {
          return (
            <p key={index} {...stylex.props(MD_P)}>
              <Inline runs={block.runs} />
            </p>
          );
        }
        return (
          <ul key={index} {...stylex.props(MD_UL)}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} {...stylex.props(MD_LI)}>
                <Inline runs={item} />
              </li>
            ))}
          </ul>
        );
      })}
    </div>
  );
}

function PlainMarkdown({ body }: { body: string }) {
  return (
    <div className={MD_ROOT} style={{ fontSize: '14px' }}>
      <p {...stylex.props(MD_P)}>{body}</p>
    </div>
  );
}

function UserAvatar({ login, size = 'md' }: { login: string; size?: 'xs' | 'md' }) {
  return (
    <span
      data-slot="avatar"
      {...stylex.props([
        powerPrComposition.part7,
        size === 'xs' ? powerPrComposition.part8 : powerPrComposition.part9,
      ])}
    >
      <span
        data-slot="avatar-fallback"
        {...stylex.props([
          powerPrComposition.part10,
          size === 'xs' ? powerPrComposition.part11 : powerPrComposition.part12,
        ])}
      >
        {login.slice(0, 2).toUpperCase()}
      </span>
    </span>
  );
}

function CardHeader({ children, wrap }: { children: ReactNode; wrap?: boolean }) {
  return (
    <header {...stylex.props([powerPrComposition.part13, wrap && powerPrComposition.part14])}>
      {children}
    </header>
  );
}

function ConversationCard({
  item,
  labels,
  intlLocale,
}: {
  item: PowerPrConversationItem;
  labels: PowerPrLabels;
  intlLocale: string;
}) {
  if (item.kind === 'comment') {
    return (
      <article {...stylex.props(powerPrStyles.surface)}>
        <CardHeader>
          <UserAvatar login={item.author} />
          <span {...stylex.props(powerPrStyles.label)}>{item.author}</span>
          <span {...stylex.props(powerPrStyles.label2)}>
            {labels.commented} · {formatDate(item.createdAt, intlLocale)}
          </span>
        </CardHeader>
        <div {...stylex.props(powerPrStyles.section)}>
          <PlainMarkdown body={item.body} />
        </div>
      </article>
    );
  }
  return (
    <article {...stylex.props(powerPrStyles.surface)}>
      <CardHeader wrap>
        <UserAvatar login={item.author} />
        <span {...stylex.props(powerPrStyles.label)}>{item.author}</span>
        <span {...stylex.props(powerPrStyles.row)}>
          <CheckCircle2 {...stylex.props(powerPrStyles.glyph)} />
          {labels.reviewApproved}
        </span>
        <span {...stylex.props(powerPrStyles.label2)}>
          {formatDate(item.submittedAt, intlLocale)}
        </span>
      </CardHeader>
      <div {...stylex.props(powerPrStyles.section)}>
        <PlainMarkdown body={item.body} />
      </div>
    </article>
  );
}

export function PowerPrView({ data, labels, intlLocale }: PowerPrViewProps) {
  return (
    <div data-power-demo-layout="inset-fill" {...stylex.props(powerPrStyles.stack)}>
      <div {...stylex.props(powerPrStyles.row2)}>
        <div {...stylex.props(powerPrStyles.row3)}>
          <span {...stylex.props(powerPrStylesNative.row)}>
            <GitPullRequest {...stylex.props(powerPrStyles.glyph)} strokeWidth={2.25} />
            <span>#{data.number}</span>
          </span>
          <span {...stylex.props(powerPrStyles.label3)}>{data.repoFullName}</span>
        </div>
        <div {...stylex.props(powerPrStyles.section2)}>
          <div data-pr-merge-action="" {...stylex.props(powerPrStyles.row4)}>
            <Button
              size="sm"
              tabIndex={-1}
              xstyle={[buttonStyles.action, buttonStyles.green, buttonStyles.merge]}
              iconSize="calc(var(--spacing) * 3.5)"
            >
              <GitMerge />
              {labels.mergeShortSquash}
            </Button>
            <Button
              size="sm"
              tabIndex={-1}
              aria-label={labels.moreActions}
              xstyle={[buttonStyles.split, buttonStyles.green]}
              iconSize="calc(var(--spacing) * 3.5)"
            >
              <ChevronDown />
            </Button>
          </div>
        </div>
      </div>

      {/* The landing power section drives this viewport's scrollTop from page
          scroll; it looks it up by `data-power-scrollport`. */}
      <div {...stylex.props(powerPrStyles.frame)}>
        <div
          data-power-scrollport=""
          data-landing-scroll-region
          {...stylex.props(powerPrStyles.frame2)}
        >
          <div {...stylex.props(prSpacing.body)}>
            <section {...stylex.props(prBlockSpacing.space1)}>
              <h2 {...stylex.props(powerPrStyles.caption)}>
                {data.title}
                <span {...stylex.props(powerPrStyles.label4)}>#{data.number}</span>
              </h2>
              <div {...stylex.props(powerPrStyles.stack2)}>
                <span {...stylex.props(powerPrStyles.row5)}>
                  <UserAvatar login={data.author} size="xs" />
                  <span {...stylex.props(powerPrStyles.label5)}>{data.author}</span>
                  <span>{labels.opened(formatDate(data.createdAt, intlLocale))}</span>
                  <span aria-hidden>·</span>
                  <span>{labels.commits(data.commits)}</span>
                </span>
                <span {...stylex.props(powerPrStyles.row6)}>
                  <span {...stylex.props(powerPrStyles.label6)}>+{data.additions}</span>
                  <span {...stylex.props(powerPrStyles.label7)}>-{data.deletions}</span>
                  <span aria-hidden>·</span>
                  <span>{labels.files(data.changedFiles)}</span>
                </span>
              </div>
              <div {...stylex.props(powerPrStyles.caption2)}>
                <Markdown blocks={data.body} />
              </div>
            </section>

            <section {...stylex.props(powerPrStyles.surface2)}>
              <div {...stylex.props(powerPrStyles.row7)}>
                <span {...stylex.props(powerPrStyles.row8)}>
                  <CheckCircle2 {...stylex.props(powerPrStyles.glyph2)} />
                  <span {...stylex.props(powerPrStyles.label8)}>{labels.checksPassed}</span>
                </span>
                <span {...stylex.props(powerPrStyles.row9)}>
                  {labels.checksCount(data.checksTotal)}
                  <ChevronDown {...stylex.props(powerPrStyles.glyph3)} aria-hidden />
                </span>
              </div>
            </section>

            <section {...stylex.props(prSpacing.section)}>
              <ul {...stylex.props(prBlockSpacing.space1_5)}>
                {data.conversation.map((item) => (
                  <li key={item.id}>
                    <ConversationCard item={item} labels={labels} intlLocale={intlLocale} />
                  </li>
                ))}
              </ul>
              <div {...stylex.props(prSpacing.section)}>
                <textarea
                  readOnly
                  tabIndex={-1}
                  rows={3}
                  placeholder={labels.composerPlaceholder}
                  data-landing-compact-composer
                  {...stylex.props(powerPrStyles.row10)}
                />
                <div {...stylex.props(powerPrStyles.row11)}>
                  <Button size="sm" disabled tabIndex={-1} xstyle={buttonStyles.compactGap}>
                    {labels.composerSubmit}
                  </Button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
